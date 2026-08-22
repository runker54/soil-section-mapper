//! 数据源装载与断面计算管线（自 make_sections.py 移植）。
use crate::gdal_ffi::*;
use serde_json::{json, Value};
use std::collections::HashMap;

pub struct Feat {
    pub attrs: HashMap<String, String>,
    pub geom: HGeom,
    pub env: crate::gdal_ffi::Envelope,   // 装载时预计算的外包络（查询免重算）
}
unsafe impl Send for Feat {}
unsafe impl Sync for Feat {}

pub struct VectorSrc {
    pub path: String,
    pub layer: String,
    pub epsg: Option<i32>,
    pub fields: Vec<String>,
    pub feats: Vec<Feat>,
}

pub struct DemSrc {
    pub path: String,
    pub ds: HDataset,
    pub band: HBand,
    pub epsg: Option<i32>,
    pub xsize: i32,
    pub ysize: i32,
    pub gt: [f64; 6],
    pub nodata: Option<f64>,
    pub emin: f64,
    pub emax: f64,
}
unsafe impl Send for DemSrc {}
unsafe impl Sync for DemSrc {}

impl Drop for DemSrc {
    fn drop(&mut self) {
        unsafe { get().map(|g| (g.f.gdal_close)(self.ds)).ok() };
    }
}

pub fn open_layers(path: &str) -> Result<Vec<Value>, String> {
    let g = get()?;
    unsafe {
        let mut p = path.as_bytes().to_vec();
        p.push(0);
        let ds = (g.f.gdal_open_ex)(p.as_ptr(), OF_VECTOR | OF_READONLY, std::ptr::null(), std::ptr::null(), std::ptr::null());
        if ds.is_null() {
            return Err(format!("打开矢量失败: {} ({})", path, g.last_error()));
        }
        let mut out = Vec::new();
        let n = (g.f.gdal_get_layer_count)(ds);
        for i in 0..n {
            let lyr = (g.f.gdal_get_layer)(ds, i);
            if lyr.is_null() { continue; }
            let defn = (g.f.ogr_l_get_defn)(lyr);
            let nf = (g.f.ogr_fd_get_field_count)(defn);
            let mut fields = Vec::new();
            for j in 0..nf {
                let fd = (g.f.ogr_fd_get_field_defn)(defn, j);
                if fd.is_null() { continue; }
                fields.push(cstr_to_string((g.f.ogr_fld_get_name)(fd)));
            }
            let count = (g.f.ogr_l_get_feature_count)(lyr, 1);
            out.push(json!({"name": cstr_to_string((g.f.ogr_l_get_name)(lyr)), "fields": fields, "count": count}));
        }
        (g.f.gdal_close)(ds);
        Ok(out)
    }
}

pub fn use_layer(path: &str, layer: &str) -> Result<VectorSrc, String> {
    let g = get()?;
    unsafe {
        let mut p = path.as_bytes().to_vec();
        p.push(0);
        let ds = (g.f.gdal_open_ex)(p.as_ptr(), OF_VECTOR | OF_READONLY, std::ptr::null(), std::ptr::null(), std::ptr::null());
        if ds.is_null() {
            return Err(format!("打开矢量失败: {} ({})", path, g.last_error()));
        }
        let mut lp = layer.as_bytes().to_vec();
        lp.push(0);
        let lyr = (g.f.gdal_get_layer_by_name)(ds, lp.as_ptr());
        if lyr.is_null() {
            (g.f.gdal_close)(ds);
            return Err(format!("未找到图层: {}", layer));
        }
        let defn = (g.f.ogr_l_get_defn)(lyr);
        let nf = (g.f.ogr_fd_get_field_count)(defn);
        let mut fields = Vec::new();
        for j in 0..nf {
            let fd = (g.f.ogr_fd_get_field_defn)(defn, j);
            if fd.is_null() { continue; }
            fields.push(cstr_to_string((g.f.ogr_fld_get_name)(fd)));
        }
        // CRS EPSG
        let mut epsg = None;
        let srs = (g.f.ogr_l_get_spatial_ref)(lyr);
        if !srs.is_null() {
            let code = (g.f.osr_authority_code)(srs, std::ptr::null());
            if !code.is_null() {
                if let Ok(v) = cstr_to_string(code).parse::<i32>() { epsg = Some(v); }
            }
            if epsg.is_none() {
                (g.f.osr_auto_identify_epsg)(srs);
                let code = (g.f.osr_authority_code)(srs, std::ptr::null());
                if !code.is_null() {
                    if let Ok(v) = cstr_to_string(code).parse::<i32>() { epsg = Some(v); }
                }
            }
        }
        // 要素（几何克隆后立即关闭数据集）
        let mut feats = Vec::new();
        (g.f.ogr_l_reset_reading)(lyr);
        loop {
            let f = (g.f.ogr_l_get_next_feature)(lyr);
            if f.is_null() { break; }
            let mut attrs = HashMap::new();
            for (j, fname) in fields.iter().enumerate() {
                let s = (g.f.ogr_f_get_field_as_string)(f, j as i32);
                attrs.insert(fname.clone(), cstr_to_string(s));
            }
            let geom_ref = (g.f.ogr_f_get_geometry_ref)(f);
            let geom = if geom_ref.is_null() { std::ptr::null_mut() } else { (g.f.ogr_g_clone)(geom_ref) };
            let mut env = Envelope { min_x: 0.0, max_x: 0.0, min_y: 0.0, max_y: 0.0 };
            if !geom.is_null() { (g.f.ogr_g_get_envelope)(geom, &mut env); }
            feats.push(Feat { attrs, geom, env });
            (g.f.ogr_f_destroy)(f);
        }
        let count = feats.len();
        (g.f.gdal_close)(ds);
        if count == 0 {
            return Err(format!("图层 {} 无有效要素", layer));
        }
        Ok(VectorSrc { path: path.into(), layer: layer.into(), epsg, fields, feats })
    }
}

pub fn open_dem(path: &str) -> Result<DemSrc, String> {
    let g = get()?;
    unsafe {
        let mut p = path.as_bytes().to_vec();
        p.push(0);
        let ds = (g.f.gdal_open_ex)(p.as_ptr(), OF_READONLY, std::ptr::null(), std::ptr::null(), std::ptr::null());
        if ds.is_null() {
            return Err(format!("打开 DEM 失败: {} ({})", path, g.last_error()));
        }
        if (g.f.gdal_get_raster_count)(ds) < 1 {
            (g.f.gdal_close)(ds);
            return Err("DEM 无波段".into());
        }
        let band = (g.f.gdal_get_raster_band)(ds, 1);
        let mut gt = [0f64; 6];
        (g.f.gdal_get_geo_transform)(ds, gt.as_mut_ptr());
        let mut has = 0i32;
        let nd = (g.f.gdal_get_nodata)(band, &mut has);
        let nodata = if has != 0 { Some(nd) } else { None };
        let wkt = cstr_to_string((g.f.gdal_get_projection_ref)(ds));
        let mut epsg = if wkt.is_empty() { None } else { epsg_from_wkt(&wkt) };
        if epsg.is_none() && !wkt.is_empty() {
            // WKT 识别兜底：SetFromUserInput + AutoIdentifyEPSG
            let srs = (g.f.osr_new_srs)(std::ptr::null());
            if !srs.is_null() {
                let mut wp = wkt.as_bytes().to_vec();
                wp.push(0);
                if (g.f.osr_set_from_user_input)(srs, wp.as_ptr()) == 0 {
                    (g.f.osr_auto_identify_epsg)(srs);
                    let code = (g.f.osr_authority_code)(srs, std::ptr::null());
                    if !code.is_null() {
                        if let Ok(v) = cstr_to_string(code).parse::<i32>() { epsg = Some(v); }
                    }
                }
                (g.f.osr_destroy_srs)(srs);
            }
        }
        let mut emin = 0f64; let mut emax = 0f64; let mut mean = 0f64; let mut sd = 0f64;
        let _ = (g.f.gdal_get_statistics)(band, 0, 1, &mut emin, &mut emax, &mut mean, &mut sd);
        Ok(DemSrc {
            path: path.into(), ds, band, epsg,
            xsize: (g.f.gdal_get_raster_xsize)(ds), ysize: (g.f.gdal_get_raster_ysize)(ds),
            gt, nodata, emin, emax,
        })
    }
}

// ---------------- 计算管线 ----------------

pub struct Pt {
    pub no: i64,
    pub name: String,
    pub x: f64,
    pub y: f64,
}

/// 多段线顶点集（线图层 CRS）
pub fn line_parts(geom: HGeom) -> Vec<Vec<(f64, f64)>> {
    let g = get().unwrap();
    unsafe {
        let mut parts = Vec::new();
        let n = (g.f.ogr_g_get_geometry_count)(geom);
        if n == 0 {
            let cnt = (g.f.ogr_g_get_point_count)(geom);
            if cnt >= 2 {
                let mut v = Vec::with_capacity(cnt as usize);
                for i in 0..cnt {
                    v.push(((g.f.ogr_g_get_x)(geom, i), (g.f.ogr_g_get_y)(geom, i)));
                }
                parts.push(v);
            }
        } else {
            for i in 0..n {
                let sub = (g.f.ogr_g_get_geometry_ref)(geom, i);
                if sub.is_null() { continue; }
                let cnt = (g.f.ogr_g_get_point_count)(sub);
                if cnt >= 2 {
                    let mut v = Vec::with_capacity(cnt as usize);
                    for j in 0..cnt {
                        v.push(((g.f.ogr_g_get_x)(sub, j), (g.f.ogr_g_get_y)(sub, j)));
                    }
                    parts.push(v);
                }
            }
        }
        parts
    }
}

pub fn densify_full(parts: &[Vec<(f64, f64)>], step: f64) -> Vec<(f64, f64, f64)> {
    let mut out = Vec::new();
    let mut cum = 0f64;
    for vs in parts {
        for w in vs.windows(2) {
            let (x1, y1) = w[0];
            let (x2, y2) = w[1];
            let seglen = ((x2 - x1).hypot(y2 - y1)).max(1e-9);
            let n = ((seglen / step).round() as i64).max(1);
            for k in 0..n {
                let t = k as f64 / n as f64;
                out.push((cum + t * seglen, x1 + t * (x2 - x1), y1 + t * (y2 - y1)));
            }
            cum += seglen;
        }
    }
    if let Some(last) = out.last() {
        out.push(*last);
    }
    out
}

pub fn project_chainage(parts: &[Vec<(f64, f64)>], px: f64, py: f64) -> (f64, f64) {
    let mut best_d = f64::MAX;
    let mut best_ch = 0f64;
    let mut cum = 0f64;
    for vs in parts {
        for w in vs.windows(2) {
            let (x1, y1) = w[0];
            let (x2, y2) = w[1];
            let dx = x2 - x1;
            let dy = y2 - y1;
            let s2 = dx * dx + dy * dy;
            let t = if s2 == 0.0 { 0.0 } else {
                (((px - x1) * dx + (py - y1) * dy) / s2).clamp(0.0, 1.0)
            };
            let qx = x1 + t * dx;
            let qy = y1 + t * dy;
            let d = (px - qx).hypot(py - qy);
            if d < best_d {
                best_d = d;
                best_ch = cum + t * s2.sqrt();
            }
            cum += s2.sqrt();
        }
    }
    (best_d, best_ch)
}

pub fn moving_avg(v: &[f64], win: usize) -> Vec<f64> {
    if v.len() < win || win < 2 {
        return v.to_vec();
    }
    let half = win / 2;
    let mut out = Vec::with_capacity(v.len());
    for i in 0..v.len() {
        let lo = i.saturating_sub(half);
        let hi = (i + half + 1).min(v.len());
        out.push(v[lo..hi].iter().sum::<f64>() / (hi - lo) as f64);
    }
    out
}

pub fn nice_ve(ve: f64) -> f64 {
    for v in [1.0, 2.0, 3.0, 5.0, 8.0, 10.0, 15.0, 20.0, 30.0] {
        if ve <= v {
            return v;
        }
    }
    30.0
}

pub const WIND8: [&str; 8] = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];

pub fn wind8(az: f64) -> &'static str {
    let idx = (((az + 22.5) % 360.0) / 45.0).floor() as usize % 8;
    WIND8[idx]
}

pub fn transform_xy(g: &Gdal, from: Option<i32>, to: Option<i32>, pts: &mut [(f64, f64)]) -> Result<(), String> {
    let (f, t) = match (from, to) {
        (Some(a), Some(b)) if a == b => return Ok(()),
        (Some(a), Some(b)) => (a, b),
        _ => return Ok(()), // 任一侧未知则假定同坐标系
    };
    unsafe {
        let src = (g.f.osr_new_srs)(std::ptr::null());
        if (g.f.osr_import_from_epsg)(src, f) != 0 {
            (g.f.osr_destroy_srs)(src);
            return Err(format!("无效 EPSG: {}", f));
        }
        (g.f.osr_set_axis_mapping)(src, OAMS_TRADITIONAL_GIS_ORDER);
        let dst = (g.f.osr_new_srs)(std::ptr::null());
        if (g.f.osr_import_from_epsg)(dst, t) != 0 {
            (g.f.osr_destroy_srs)(src);
            (g.f.osr_destroy_srs)(dst);
            return Err(format!("无效 EPSG: {}", t));
        }
        (g.f.osr_set_axis_mapping)(dst, OAMS_TRADITIONAL_GIS_ORDER);
        let ct = (g.f.oct_new_ct)(src, dst);
        if ct.is_null() {
            (g.f.osr_destroy_srs)(src);
            (g.f.osr_destroy_srs)(dst);
            return Err("创建坐标变换失败".into());
        }
        let n = pts.len();
        let mut xs: Vec<f64> = pts.iter().map(|p| p.0).collect();
        let mut ys: Vec<f64> = pts.iter().map(|p| p.1).collect();
        let mut zs: Vec<f64> = vec![0.0; n];
        let ok = (g.f.oct_transform)(ct, n as i32, xs.as_mut_ptr(), ys.as_mut_ptr(), zs.as_mut_ptr());
        (g.f.oct_destroy_ct)(ct);
        (g.f.osr_destroy_srs)(src);
        (g.f.osr_destroy_srs)(dst);
        if ok != 0 {
            for (i, p) in pts.iter_mut().enumerate() {
                *p = (xs[i], ys[i]);
            }
            Ok(())
        } else {
            Err(format!("坐标变换执行失败: EPSG:{} -> EPSG:{}", f, t))
        }
    }
}

pub fn dem_sample(dem: &DemSrc, x: f64, y: f64) -> Option<f64> {
    let g = get().ok()?;
    unsafe {
        let col = ((x - dem.gt[0]) / dem.gt[1]) as i32;
        let row = ((y - dem.gt[3]) / dem.gt[5]) as i32;
        if col < 0 || col >= dem.xsize || row < 0 || row >= dem.ysize {
            return None;
        }
        let mut val: f64 = 0.0;
        let rc = (g.f.gdal_raster_io)(dem.band, 0, col, row, 1, 1,
                                    &mut val as *mut f64 as *mut std::ffi::c_void,
                                    1, 1, GDT_FLOAT64, 0, 0);
        if rc != 0 {
            return None;
        }
        if let Some(nd) = dem.nodata {
            if (val - nd).abs() < 1e-9 {
                return None;
            }
        }
        Some(val)
    }
}

/// 点位土种查询：包络预筛 + OGR Contains；未命中时 500m 内就近兜底
pub fn soil_at(soil: &VectorSrc, gx: f64, gy: f64) -> Option<(String, String, String, String)> {
    let g = get().ok()?;
    const FALLBACK_M: f64 = 500.0;
    unsafe {
        let pt = (g.f.ogr_g_create_geometry)(WKB_POINT);
        if pt.is_null() { return None; }
        (g.f.ogr_g_add_point_2d)(pt, gx, gy);
        let mut best: Option<(f64, &Feat)> = None;
        let mut result = None;
        for f in soil.feats.iter() {
            if f.geom.is_null() { continue; }
            let env = &f.env;
            if gx < env.min_x || gx > env.max_x || gy < env.min_y || gy > env.max_y {
                // 仅对包络 500m 邻近范围内的图斑算距离
                if gx > env.min_x - FALLBACK_M && gx < env.max_x + FALLBACK_M
                    && gy > env.min_y - FALLBACK_M && gy < env.max_y + FALLBACK_M {
                    let d = (g.f.ogr_g_distance)(f.geom, pt);
                    if best.map(|(bd, _)| d < bd).unwrap_or(d <= FALLBACK_M) {
                        best = Some((d, f));
                    }
                }
                continue;
            }
            if (g.f.ogr_g_contains)(f.geom, pt) != 0 {
                result = Some(f);
                break;
            }
        }
        let hit = result.or_else(|| match best {
            Some((d, f)) if d <= FALLBACK_M => Some(f),
            _ => None,
        });
        (g.f.ogr_g_destroy)(pt);
        hit.map(|f| {
            let get = |k: &str| f.attrs.get(k).cloned().unwrap_or_default();
            (get("TL"), get("YL"), get("TS"), get("TZ"))
        })
    }
}

/// 精确点选（无 500m 邻近兜底）：包络过滤 + 点包含，地图信息卡专用，毫秒级
pub fn soil_at_exact(soil: &VectorSrc, gx: f64, gy: f64) -> Option<(String, String, String, String)> {
    let g = get().ok()?;
    unsafe {
        let pt = (g.f.ogr_g_create_geometry)(WKB_POINT);
        if pt.is_null() { return None; }
        (g.f.ogr_g_add_point_2d)(pt, gx, gy);
        let mut result = None;
        for f in soil.feats.iter() {
            if f.geom.is_null() { continue; }
            if gx < f.env.min_x || gx > f.env.max_x || gy < f.env.min_y || gy > f.env.max_y { continue; }
            if (g.f.ogr_g_contains)(f.geom, pt) != 0 { result = Some(f); break; }
        }
        (g.f.ogr_g_destroy)(pt);
        result.map(|f| {
            let get = |k: &str| f.attrs.get(k).cloned().unwrap_or_default();
            (get("TL"), get("YL"), get("TS"), get("TZ"))
        })
    }
}

pub fn attr_by_field(f: &Feat, field: &str) -> String {
    if field.is_empty() { return String::new(); }
    f.attrs.get(field).cloned().unwrap_or_default()
}
