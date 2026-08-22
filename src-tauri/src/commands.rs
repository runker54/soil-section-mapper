//! Tauri 命令层：数据源装载、断面计算、文件对话框/读写、内置表。
use crate::builtin;
use crate::gdal_ffi::{self, get, Envelope, GDT_FLOAT64, WKB_POINT};
use crate::pipeline::*;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::State;

pub struct AppState {
    pub builtin2: Option<crate::builtin::Builtin>,
    pub line_src: Option<VectorSrc>,
    pub point_src: Option<VectorSrc>,
    pub soil_src: Option<VectorSrc>,
    pub dem: Option<DemSrc>,
    pub custom_line: Option<(Vec<Vec<(f64, f64)>>, i32)>,
    pub custom_points: Option<Vec<(f64, f64, String)>>,
    pub dem_image: Option<DemImage>,
}

pub type SharedState = Mutex<AppState>;

fn zone_color_key(z: &Value) -> String {
    let b = builtin::get();
    let k = z.get("color_key").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if !k.is_empty() && b.color_by_name.contains_key(&k) { return k; }
    let nm = z.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if b.color_by_name.contains_key(&nm) { return nm; }
    if let Some(stripped) = nm.strip_suffix('带') {
        let stripped = stripped.to_string();
        if b.color_by_name.contains_key(&stripped) { return stripped; }
    }
    k
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}
fn f_opt(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(|x| x.as_f64())
}
fn i_opt(v: &Value, k: &str) -> Option<i64> {
    v.get(k).and_then(|x| x.as_i64())
}

#[tauri::command]
pub fn gdal_init(dir: String) -> Result<Value, String> {
    let g = gdal_ffi::init(&dir)?;
    Ok(json!({"version": g.version()}))
}

/// 当前生效的内置表（用户导入覆盖优先）
pub fn blt(st: &AppState) -> &crate::builtin::Builtin {
    st.builtin2.as_ref().unwrap_or_else(|| crate::builtin::get())
}

/// 用户导入土种编码/色带 JSON：{ "codes": [{code,tz,ts,yl,tl}], "colors": [{name,hex,level}] }
/// 缺省项（codes/colors 为空数组或缺失）保留内置对应部分合并
#[tauri::command]
pub async fn import_builtin(state: State<'_, SharedState>, path: String) -> Result<Value, String> {
    let txt = std::fs::read_to_string(&path).map_err(|e| format!("读取失败: {}", e))?;
    let v: Value = serde_json::from_str(&txt).map_err(|e| format!("JSON 解析失败: {}", e))?;
    let mut st = state.lock().unwrap();
    let base = crate::builtin::get();
    let user_codes = v.get("codes").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    let user_colors = v.get("colors").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    let (codes, colors) = if user_codes.is_empty() && user_colors.is_empty() {
        return Err("JSON 中无有效 codes/colors 数组".into());
    } else if user_codes.is_empty() {
        (base.codes.clone(), Value::Array(user_colors))
    } else if user_colors.is_empty() {
        (Value::Array(user_codes), base.colors.clone())
    } else {
        (Value::Array(user_codes), Value::Array(user_colors))
    };
    st.builtin2 = Some(crate::builtin::build(codes, colors));
    let b = st.builtin2.as_ref().unwrap();
    Ok(json!({ "codes": b.codes.as_array().map(|a| a.len()).unwrap_or(0),
               "colors": b.colors.as_array().map(|a| a.len()).unwrap_or(0) }))
}

/// 恢复内置表
#[tauri::command]
pub async fn reset_builtin(state: State<'_, SharedState>) -> Result<(), String> {
    state.lock().unwrap().builtin2 = None;
    Ok(())
}

#[tauri::command]
pub fn gdal_default_dir() -> String {
    // 便携优先：exe 同级 gdal 目录（内含 gdal*.dll、gdal_data、proj_data）
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let portable = dir.join("gdal");
            let has_gdal = std::fs::read_dir(&portable)
                .map(|rd| rd.filter_map(|e| e.ok())
                    .any(|e| e.file_name().to_string_lossy().to_lowercase().starts_with("gdal")
                         && e.path().extension().map(|x| x.eq_ignore_ascii_case("dll")).unwrap_or(false)))
                .unwrap_or(false);
            if has_gdal {
                return portable.to_string_lossy().into_owned();
            }
        }
    }
    // 开发期默认：项目内独立 venv 的 rasterio.libs
    let p = std::path::Path::new(r"E:\zcode_worker\土壤类型断面图\app_gdal_env\Lib\site-packages\rasterio.libs");
    if p.is_dir() {
        p.to_string_lossy().into_owned()
    } else {
        String::new()
    }
}

#[tauri::command]
pub async fn vector_layers(path: String) -> Result<Vec<Value>, String> {
    open_layers(&path)
}

#[tauri::command]
pub async fn use_line(state: State<'_, SharedState>, path: String, layer: String) -> Result<Value, String> {
    let mut st = state.lock().unwrap();
    use_line_impl(&mut st, &path, &layer)
}

pub fn use_line_impl(st: &mut AppState, path: &str, layer: &str) -> Result<Value, String> {
    let src = use_layer(path, layer)?;
    let g = get()?;
    let mut lines = Vec::new();
    for (i, f) in src.feats.iter().enumerate() {
        let mut len_m = if f.geom.is_null() { 0.0 } else {
            unsafe {
                let direct = (g.f.ogr_g_length)(f.geom);
                if direct > 0.0 { direct } else {
                    let parts = line_parts(f.geom);
                    parts.iter().map(|vs| {
                        vs.windows(2).map(|w| (w[1].0 - w[0].0).hypot(w[1].1 - w[0].1)).sum::<f64>()
                    }).sum::<f64>()
                }
            }
        };
        // 地理坐标（4326/4490）的长度单位是度：转 CGCS2000 三度带米制后重算，
        // 否则线长显示 ≈0（如 0.0001 km）
        if let Some(epsg) = src.epsg {
            if (epsg == 4326 || epsg == 4490) && !f.geom.is_null() {
                let mut parts = line_parts(f.geom);
                let mut total = 0.0;
                for part in parts.iter_mut() {
                    if geo_to_metric(g, part, epsg).is_ok() {
                        total += part.windows(2).map(|w| (w[1].0 - w[0].0).hypot(w[1].1 - w[0].1)).sum::<f64>();
                    }
                }
                if total > 0.0 { len_m = total; }
            }
        }
        let len_km = len_m / 1000.0;
        let label = ["备注", "名称", "Name", "name"]
            .iter()
            .find_map(|k| f.attrs.get(*k).filter(|v| !v.is_empty()).cloned())
            .or_else(|| src.fields.iter()
                .find_map(|fd| f.attrs.get(fd).filter(|v| !v.is_empty()).cloned()))
            .unwrap_or_default();
        lines.push(json!({"index": i, "len_km": (len_km * 100.0).round() / 100.0, "label": label}));
    }
    let out = json!({"fields": src.fields, "epsg": src.epsg, "count": src.feats.len(), "lines": lines});
    st.line_src = Some(src);
    Ok(out)
}

#[tauri::command]
pub async fn use_points(state: State<'_, SharedState>, path: String, layer: String) -> Result<Value, String> {
    let mut st = state.lock().unwrap();
    use_points_impl(&mut st, &path, &layer)
}

pub fn use_points_impl(st: &mut AppState, path: &str, layer: &str) -> Result<Value, String> {
    let src = use_layer(path, layer)?;
    let out = json!({"fields": src.fields, "epsg": src.epsg, "count": src.feats.len()});
    st.point_src = Some(src);
    Ok(out)
}

#[tauri::command]
pub async fn use_soil(state: State<'_, SharedState>, path: String, layer: String,
                tl: String, yl: String, ts: String, tz: String,
                admin: String, lithology: String) -> Result<Value, String> {
    let mut st = state.lock().unwrap();
    use_soil_impl(&mut st, &path, &layer, &tl, &yl, &ts, &tz, &admin, &lithology)
}

pub fn use_soil_impl(st: &mut AppState, path: &str, layer: &str,
                     tl: &str, yl: &str, ts: &str, tz: &str,
                     admin: &str, lithology: &str) -> Result<Value, String> {
    let mut src = use_layer(path, layer)?;
    // 将用户映射的字段名规范化为 TL/YL/TS/TZ/ADMIN/LITH
    let mut tl = tl.to_string(); let mut yl = yl.to_string(); let mut ts = ts.to_string(); let mut tz = tz.to_string();
    let remap = |src: &mut VectorSrc, from: &mut String, to: &str| {
        if !from.is_empty() && from != to && src.fields.iter().any(|f| f == &*from) {
            for f in src.feats.iter_mut() {
                if let Some(v) = f.attrs.remove(&*from) {
                    f.attrs.insert(to.to_string(), v);
                }
            }
        }
    };
    remap(&mut src, &mut tl, "TL");
    remap(&mut src, &mut yl, "YL");
    remap(&mut src, &mut ts, "TS");
    remap(&mut src, &mut tz, "TZ");
    let mut admin = admin.to_string();
    remap(&mut src, &mut admin, "ADMIN");
    let mut lithology = lithology.to_string();
    remap(&mut src, &mut lithology, "LITH");
    let out = json!({"fields": src.fields, "epsg": src.epsg, "count": src.feats.len()});
    st.soil_src = Some(src);
    Ok(out)
}

#[tauri::command]
pub async fn use_dem(state: State<'_, SharedState>, path: String) -> Result<Value, String> {
    let mut st = state.lock().unwrap();
    use_dem_impl(&mut st, &path)
}

/// 点选查询：土壤图斑字段 + DEM 高程（地图工作台信息卡）
#[tauri::command]
pub async fn soil_query(state: State<'_, SharedState>, x: f64, y: f64, epsg: Option<i32>) -> Result<Value, String> {
    let st = state.lock().unwrap();
    soil_query_impl(&st, x, y, epsg)
}

pub fn soil_query_impl(st: &AppState, x: f64, y: f64, epsg: Option<i32>) -> Result<Value, String> {
    let g = get()?;
    let soil = st.soil_src.as_ref().ok_or("未加载土壤图")?;
    // 输入坐标（默认 4326 经纬度）转土壤图 CRS
    let (x, y) = {
        let mut p = vec![(x, y)];
        let src = epsg.or(Some(4326));
        let dst = soil.epsg;
        if (src != dst) && transform_xy(g, src, dst, &mut p).is_ok() { (p[0].0, p[0].1) } else { (p[0].0, p[0].1) }
    };
    let (tl, yl, ts, tz) = match soil_at_exact(soil, x, y) {
        Some(v) => v,
        None => (String::new(), String::new(), String::new(), String::new()),
    };
    let mut elev = None;
    if let Some(dem) = st.dem.as_ref() {
        let mut p = vec![(x, y)];
        let soil_epsg: Option<i32> = soil.epsg;
        if transform_xy(g, soil_epsg, dem.epsg, &mut p).is_ok() {
            elev = dem_sample(dem, p[0].0, p[0].1);
        }
    }
    Ok(json!({
        "found": !tl.is_empty() || !tz.is_empty(),
        "tl": tl, "yl": yl, "ts": ts, "tz": tz,
        "elev": elev,
    }))
}

pub fn use_dem_impl(st: &mut AppState, path: &str) -> Result<Value, String> {
    let dem = open_dem(path)?;
    st.dem_image = None;   // 换 DEM：全图渲染缓存失效
    let out = json!({
        "epsg": dem.epsg, "xsize": dem.xsize, "ysize": dem.ysize,
        "gt": dem.gt, "nodata": dem.nodata, "emin": dem.emin, "emax": dem.emax
    });
    st.dem = Some(dem);
    Ok(out)
}

/// 主计算命令：完整移植 make_sections.py 管线
#[tauri::command]
pub async fn compute_section(state: State<'_, SharedState>, req: Value) -> Result<Value, String> {
    let st = state.lock().unwrap();
    compute_impl(&st, req)
}

pub fn compute_impl(st: &AppState, req: Value) -> Result<Value, String> {
    let dem = st.dem.as_ref().ok_or("未加载 DEM")?;
    let g = get()?;

    // ---- 参数 ----
    let step = f_opt(&req, "sample_interval_m").unwrap_or(50.0).max(1.0);
    let orientation = s(&req, "orientation"); // high_left / high_right / as_line
    let ve_mode = f_opt(&req, "ve");
    let smoothing = i_opt(&req, "smoothing").unwrap_or(5).max(0) as usize;
    let line_index = i_opt(&req, "line_index").unwrap_or(0) as usize;
    let use_custom = req.get("use_custom").and_then(|v| v.as_bool()).unwrap_or(false);

    // ---- 线来源：自定义绘制线 或 图层线 ----
    let (mut parts, mut line_epsg): (Vec<Vec<(f64, f64)>>, Option<i32>) = if use_custom {
        let c = st.custom_line.as_ref().ok_or("尚未在地图工作台绘制断面线")?;
        let parts = c.0.clone();
        if parts.is_empty() || parts.iter().any(|p| p.len() < 2) {
            return Err("绘制的断面线点数不足".into());
        }
        (parts, Some(c.1))
    } else {
        let line_src = st.line_src.as_ref().ok_or("未加载断面线")?;
        let line_feat = line_src.feats.get(line_index).ok_or("断面线索引无效")?;
        if line_feat.geom.is_null() {
            return Err("断面线几何为空".into());
        }
        (line_parts(line_feat.geom), line_src.epsg)
    };
    // 导入线若为地理坐标（4326/4490）→ 先转 CGCS2000 三度带米制（与自绘线 geo_to_metric 一致），
    // 保证里程/加密/外延在米制下计算正确（否则度数被当米，总长≈0）
    if !use_custom {
        if let Some(epsg) = line_epsg {
            if epsg == 4326 || epsg == 4490 {
                for p in parts.iter_mut() {
                    if let Ok(target) = geo_to_metric(g, p, epsg) {
                        line_epsg = Some(target);
                    }
                }
            }
        }
    }
    if parts.is_empty() {
        return Err("断面线无有效折线".into());
    }
    let stations = densify_full(&parts, step);
    let total = stations.last().map(|(c, _, _)| *c).unwrap_or(0.0);
    if total <= 0.0 {
        return Err("断面线长度为 0".into());
    }
    // 两端自适应外延（沿首末段方向线性外插）：每端 3% 线长，
    // 钳制 [2 个采样间隔, 1500m]——端点标注不贴框，长短线观感一致；
    // 方位角/总长仍取原始线
    let n_orig = stations.len();
    let ext_req = f_opt(&req, "extend_m").unwrap_or(0.0);
    let n_ext = if ext_req > 0.0 {
        ((ext_req).clamp(2.0 * step, 60000.0) / step).round() as usize
    } else {
        (((total * 0.03).clamp(2.0 * step, 1500.0)) / step).round() as usize
    };
    let n_ext = n_ext.clamp(2, (n_orig / 3).max(2));
    let mut stations_x: Vec<(f64, f64, f64)> = Vec::with_capacity(n_orig + 2 * n_ext);
    if n_orig >= 2 {
        let dir = |ax: f64, ay: f64, bx: f64, by: f64| {
            let d = ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt().max(1e-9);
            ((bx - ax) / d, (by - ay) / d)
        };
        let (c0, x0, y0) = stations[0];
        let (_, x1, y1) = stations[1];
        let (ux, uy) = dir(x0, y0, x1, y1);
        for k in (1..=n_ext).rev() {
            let s = step * k as f64;
            stations_x.push((c0 - s, x0 - ux * s, y0 - uy * s));
        }
        stations_x.extend(stations.iter().copied());
        let (cn, xn, yn) = stations[n_orig - 1];
        let (_, xm, ym) = stations[n_orig - 2];
        let (vx, vy) = dir(xm, ym, xn, yn);
        for k in 1..=n_ext {
            let s = step * k as f64;
            stations_x.push((cn + s, xn + vx * s, yn + vy * s));
        }
    } else {
        stations_x.extend(stations.iter().copied());
    }
    let stations = stations_x;
    let mut dem_pts: Vec<(f64, f64)> = stations.iter().map(|(_, x, y)| (*x, *y)).collect();
    transform_xy(g, line_epsg, dem.epsg, &mut dem_pts)?;

    let mut elev: Vec<f64> = Vec::with_capacity(stations.len());
    for p in &dem_pts {
        match dem_sample(dem, p.0, p.1) {
            Some(v) => elev.push(v),
            None => elev.push(*elev.last().unwrap_or(&0.0)),
        }
    }
    let elev_s = if smoothing >= 3 { moving_avg(&elev, smoothing) } else { elev.clone() };
    let ch_arr: Vec<f64> = stations.iter().map(|(c, _, _)| *c).collect();

    let e_end = |i: usize| -> f64 {
        elev.get(i).copied().unwrap_or(0.0)
    };
    // ---- 定向 ----
    let flip = match orientation.as_str() {
        "high_right" => e_end(0) > *elev.last().unwrap_or(&0.0),
        "as_line" => false,
        _ => e_end(0) < *elev.last().unwrap_or(&0.0), // high_left 默认
    };
    let (ch_arr, elev, elev_s, dem_pts): (Vec<f64>, Vec<f64>, Vec<f64>, Vec<(f64, f64)>) = if flip {
        (
            ch_arr.iter().rev().map(|c| total - c).collect(),
            elev.iter().rev().copied().collect(),
            elev_s.iter().rev().copied().collect(),
            dem_pts.iter().rev().copied().collect(),
        )
    } else {
        (ch_arr, elev, elev_s, dem_pts)
    };

    // 方位角（定向后原始线首尾；跳过两端外延点，保持全线方向语义）
    let az = {
        let n = dem_pts.len();
        let i0 = n_ext.min(n.saturating_sub(1));
        let i1 = n.saturating_sub(1 + n_ext);
        if i1 > i0 {
            let (x0, y0) = dem_pts[i0];
            let (x1, y1) = dem_pts[i1];
            (x1 - x0).atan2(y1 - y0).to_degrees().rem_euclid(360.0)
        } else { 0.0 }
    };

    // ---- 断面点 ----
    let name_field = s(&req, "point_name_field");
    let no_field = s(&req, "point_no_field");
    let filter = req.get("point_filter").cloned().unwrap_or(json!({"mode": "all", "max_dist_m": 600.0}));
    let fmode = s(&filter, "mode");
    let ffield = s(&filter, "field");
    let fvalue = s(&filter, "value");
    let max_dist = f_opt(&filter, "max_dist_m").unwrap_or(600.0);

    let soil_src = st.soil_src.as_ref().ok_or("未加载土壤图")?;
    struct RawPt { x: f64, y: f64, name: String, no: Option<i64>, keep: bool, admin: String, lith: String }
    let raw_points: Vec<RawPt> = if use_custom {
        st.custom_points.as_ref().map(|v| v.iter().enumerate().map(|(i, (x, y, nm))|
            RawPt { x: *x, y: *y, name: if nm.is_empty() { format!("点{}", i + 1) } else { nm.clone() }, no: None, keep: true, admin: String::new(), lith: String::new() }
        ).collect()).ok_or("尚未在地图工作台布点")?
    } else {
        let point_src = st.point_src.as_ref().ok_or("未加载断面点")?;
        point_src.feats.iter().filter(|pf| !pf.geom.is_null()).enumerate().map(|(i, pf)| {
            let keep = if fmode == "field" {
                pf.attrs.get(&ffield).cloned().unwrap_or_default() == fvalue
            } else { true };
            RawPt {
                x: unsafe { (g.f.ogr_g_get_x)(pf.geom, 0) },
                y: unsafe { (g.f.ogr_g_get_y)(pf.geom, 0) },
                name: if name_field.is_empty() { String::new() } else {
                    pf.attrs.get(&name_field).cloned().unwrap_or_default()
                },
                no: pf.attrs.get(&no_field).and_then(|v| v.trim().parse::<i64>().ok()).or(Some(i as i64)),
                keep,
                admin: pf.attrs.get("ADMIN").cloned().unwrap_or_default(),
                lith: pf.attrs.get("LITH").cloned().unwrap_or_default(),
            }
        }).collect()
    };

    struct MPt {
        no: i64, name: String, ch: f64, elev: Option<f64>,
        tl: String, yl: String, ts: String, tz: String,
        code: String, color: String, admin: String, lith: String,
    }
    let mut members: Vec<MPt> = Vec::new();
    for (i, rp) in raw_points.iter().enumerate() {
        if !rp.keep { continue; }
        if fmode == "field" && !use_custom {
            // 字段过滤已在 keep 中处理
        }
        let mut arr = [(rp.x, rp.y)];
        // 点 CRS -> 线 CRS
        if use_custom {
            // 自定义点与线同 CRS，无需变换
        } else {
            let psrc = st.point_src.as_ref().unwrap();
            transform_xy(g, psrc.epsg, line_epsg, &mut arr)?;
        }
        let (px, py) = arr[0];
        let (d, ch0) = project_chainage(&parts, px, py);
        // 里程钳制：加密线总长因采样取整略短于几何真长，避免端点被挤出图外
        let ch = ch0.clamp(0.0, total);
        if fmode != "field" && d > max_dist { continue; }
        // 点已转至线 CRS（米制，导入线可能 4326->三度带），土壤/DEM 查询均以线 CRS 为基准；
        // 若仍用 point_src 原始 epsg 变换米制坐标，tmerc 会报 Invalid latitude
        let pt_epsg = line_epsg;
        let mut sp = [(px, py)];
        transform_xy(g, pt_epsg, soil_src.epsg, &mut sp)?;
        let (tl, yl, ts, tz) = soil_at(soil_src, sp[0].0, sp[0].1)
            .unwrap_or((String::new(), String::new(), String::new(), String::new()));
        // 点 CRS -> DEM CRS 取高程
        let mut dp = [(px, py)];
        transform_xy(g, pt_epsg, dem.epsg, &mut dp)?;
        let elev = dem_sample(dem, dp[0].0, dp[0].1);

        let no = rp.no.unwrap_or(i as i64 + 1);
        let name = rp.name.clone();
        let bl = blt(st);
        let code = bl.code_of_ov(&tz).unwrap_or_default();
        let color = bl.color_of_ov(&tz, &ts, &yl, &tl);
        let admin = rp.admin.clone();
        let lith = rp.lith.clone();
        members.push(MPt {
            no, name, ch, elev, tl, yl, ts, tz, code, color, admin, lith,
        });
    }

    // ---- 应用表格覆盖（删行=删点、新增行=加点）----
    if let Some(rows) = req.get("points_override").and_then(|v| v.as_array()).filter(|r| !r.is_empty()) {
        let mut kept: Vec<MPt> = Vec::new();
        let mut seen: Vec<i64> = Vec::new();
        for m in members.into_iter() {
            let r = rows.iter().find(|r| i_opt(r, "no") == Some(m.no));
            let r = match r {
                Some(r) => r,
                None => continue, // 行被删除
            };
            seen.push(m.no);
            let mut mm = m;
            let name = s(r, "name");
            if !name.is_empty() { mm.name = name; }
            if let Some(e) = f_opt(r, "elev") { mm.elev = Some(e); }
            if let Some(c) = f_opt(r, "ch_km") { mm.ch = c * 1000.0; }
            let code = s(r, "code");
            if !code.is_empty() { mm.code = code; }
            let tz = s(r, "tz");
            if !tz.is_empty() {
                mm.tz = tz.clone();
                let ts = s(r, "ts"); if !ts.is_empty() { mm.ts = ts; }
                let yl = s(r, "yl"); if !yl.is_empty() { mm.yl = yl; }
                let tl = s(r, "tl"); if !tl.is_empty() { mm.tl = tl; }
                mm.color = blt(st).color_of_ov(&mm.tz, &mm.ts, &mm.yl, &mm.tl);
                if s(r, "code").is_empty() {
                    if let Some(c) = blt(st).code_of_ov(&mm.tz) { mm.code = c; }
                }
            }
            let admin = s(r, "admin"); if !admin.is_empty() { mm.admin = admin; }
            let lith = s(r, "lith"); if !lith.is_empty() { mm.lith = lith; }
            let color = s(r, "color");
            if color.starts_with('#') { mm.color = color; }
            kept.push(mm);
        }
        // 新增行
        for r in rows {
            let no = match i_opt(r, "no") { Some(v) => v, None => continue };
            if seen.contains(&no) { continue; }
            let tz = s(r, "tz");
            kept.push(MPt {
                no,
                name: s(r, "name"),
                ch: f_opt(r, "ch_km").unwrap_or(0.0) * 1000.0,
                elev: f_opt(r, "elev"),
                tl: s(r, "tl"), yl: s(r, "yl"), ts: s(r, "ts"), tz: tz.clone(),
                code: if s(r, "code").is_empty() { blt(st).code_of_ov(&tz).unwrap_or_default() } else { s(r, "code") },
                color: blt(st).color_of_ov(&tz, &s(r, "ts"), &s(r, "yl"), &s(r, "tl")),
                admin: s(r, "admin"), lith: s(r, "lith"),
            });
        }
        members = kept;
    }

    members.sort_by(|a, b| a.ch.partial_cmp(&b.ch).unwrap_or(std::cmp::Ordering::Equal));

    // ---- 分段（相邻点中点）与统计 ----
    let mut bounds: Vec<f64> = vec![0.0];
    for w in members.windows(2) {
        bounds.push((w[0].ch + w[1].ch) / 2.0);
    }
    bounds.push(total);

    let interp = |ch: f64| -> f64 {
        // 线性插值高程
        if ch_arr.is_empty() { return 0.0; }
        let mut lo = 0usize; let mut hi = ch_arr.len() - 1;
        if ch <= ch_arr[0] { return elev[0]; }
        if ch >= ch_arr[hi] { return elev[hi]; }
        while hi - lo > 1 {
            let mid = (lo + hi) / 2;
            if ch_arr[mid] <= ch { lo = mid } else { hi = mid }
        }
        let t = (ch - ch_arr[lo]) / (ch_arr[hi] - ch_arr[lo]).max(1e-9);
        elev[lo] + t * (elev[hi] - elev[lo])
    };

    let mut pts_json = Vec::new();
    let mut segs_json = Vec::new();
    for (k, m) in members.iter().enumerate() {
        let e_p = m.elev.unwrap_or_else(|| interp(m.ch));
        let (x0, x1) = (bounds[k], bounds[k + 1]);
        let mut emin = f64::MAX; let mut emax = f64::MIN; let mut esum = 0.0; let mut en = 0.0;
        for (i, c) in ch_arr.iter().enumerate() {
            if *c >= x0 && *c <= x1 {
                emin = emin.min(elev[i]); emax = emax.max(elev[i]);
                esum += elev[i]; en += 1.0;
            }
        }
        if en == 0.0 { emin = e_p; emax = e_p; esum = e_p; en = 1.0; }
        pts_json.push(json!({
            "no": m.no, "name": m.name, "ch_km": m.ch / 1000.0, "elev": e_p,
            "code": m.code, "tz": m.tz, "ts": m.ts, "yl": m.yl, "tl": m.tl,
            "color": m.color, "admin": m.admin, "lith": m.lith,
        }));
        // 地貌部位（贵州山间地貌经验划分，自 Python 版 geomorph 移植）
        let mean_e = esum / en;
        let rel = emax - emin;
        let base = if mean_e >= 1500.0 { "中山" }
            else if mean_e >= 1100.0 { "低中山" }
            else if mean_e >= 800.0 { "丘陵" }
            else { "河谷" };
        let pre = if m.tl == "石灰岩土" { "岩溶" }
            else if m.tl == "水稻土" && rel < 120.0 { "坝子" }
            else { "侵蚀" };
        let geo = format!("{}{}", pre, base);
        segs_json.push(json!({
            "x0_km": x0 / 1000.0, "x1_km": x1 / 1000.0,
            "no": m.no, "code": m.code, "tz": m.tz, "ts": m.ts, "yl": m.yl, "tl": m.tl,
            "color": m.color, "admin": m.admin, "lith": m.lith, "geo": geo,
            "emin": emin, "emean": mean_e, "emax": emax,
        }));
    }

    // ---- 垂直夸张 / 地带界线 ----
    let e_min = elev_s.iter().cloned().fold(f64::INFINITY, f64::min);
    let e_max = elev_s.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let e_span = (e_max - e_min).max(1.0);
    let ve = ve_mode.filter(|v| *v >= 1.0).unwrap_or_else(|| nice_ve(0.35 * total / e_span));

    let mut zones_json = Vec::new();
    if let Some(zs) = req.get("zones").and_then(|v| v.as_array()) {
        for z in zs {
            let z0 = match f_opt(z, "elev") { Some(v) => v, None => continue };
zones_json.push(json!({
                    "elev": z0, "name": s(z, "name"),
                    "color": blt(st).color_of_ov(&zone_color_key(z), "", "", ""),
                }));
        }
    }

    Ok(json!({
        "total_km": total / 1000.0,
        "ext_km": (n_ext as f64 * step) / 1000.0,
        "sample_count": ch_arr.len(),
        "stations": ch_arr.iter().zip(elev_s.iter())
            .map(|(c, e)| json!([ (c.round()) / 1000.0, (*e * 10.0).round() / 10.0 ]))
            .collect::<Vec<_>>(),
        "elev_min": e_min, "elev_max": e_max,
        "y_base": ((e_min - 60.0) / 100.0).floor() * 100.0,
        "ve": ve, "flip": flip,
        "azimuth": az, "wind": wind8(az),
        "points": pts_json, "segments": segs_json, "zones": zones_json,
    }))
}

// 占位辅助

// ---------------- 地图工作台：自定义绘制线/点 ----------------

/// 地理坐标（4326/4490）→ CGCS2000 三度带米制（按质心自动选带 EPSG:4534+z）；
/// 已是投影系则原样返回。保证自绘线点在米制下参与里程/加密计算。
pub fn geo_to_metric(g: &crate::gdal_ffi::Gdal, pts: &mut Vec<(f64, f64)>, epsg: i32) -> Result<i32, String> {
    if epsg != 4326 && epsg != 4490 { return Ok(epsg); }
    let lon: f64 = pts.iter().map(|p| p.0).sum::<f64>() / pts.len() as f64;
    let lat: f64 = pts.iter().map(|p| p.1).sum::<f64>() / pts.len() as f64;
    let z = ((lon - 75.0) / 3.0).round().clamp(0.0, 20.0) as i32;
    let target: i32 = 4534 + z;
    crate::pipeline::transform_xy(g, Some(epsg), Some(target), pts)?;
    let _ = lat;
    Ok(target)
}

#[tauri::command]
pub async fn set_custom_line(state: State<'_, SharedState>, mut pts: Vec<(f64, f64)>, epsg: i32) -> Result<Value, String> {
    if pts.len() < 2 {
        return Err("断面线至少需要 2 个顶点".into());
    }
    let g = get()?;
    let epsg = geo_to_metric(&g, &mut pts, epsg)?;
    let len_m: f64 = pts.windows(2).map(|w| (w[1].0 - w[0].0).hypot(w[1].1 - w[0].1)).sum();
    if len_m < 1.0 {
        return Err("断面线长度为 0".into());
    }
    let n = pts.len();
    state.lock().unwrap().custom_line = Some((vec![pts], epsg));
    Ok(json!({"vertices": n, "length_km": (len_m / 1000.0 * 100.0).round() / 100.0}))
}

#[tauri::command]
pub async fn set_custom_points(state: State<'_, SharedState>, mut pts: Vec<(f64, f64)>, names: Vec<String>, epsg: i32) -> Result<Value, String> {
    if pts.is_empty() {
        // 空数组 = 清空已存自绘点（剖面无点时防旧数据残留）
        state.lock().unwrap().custom_points = None;
        return Ok(json!({ "count": 0 }));
    }
    let g = get()?;
    let epsg = geo_to_metric(&g, &mut pts, epsg)?;
    let v: Vec<(f64, f64, String)> = pts.into_iter().enumerate()
        .map(|(i, (x, y))| (x, y, names.get(i).cloned().unwrap_or_else(|| format!("点{}", i + 1))))
        .collect();
    let n = v.len();
    state.lock().unwrap().custom_points = Some(v);
    Ok(json!({"count": n, "epsg": epsg}))
}

#[tauri::command]
pub fn clear_custom(state: State<'_, SharedState>) -> Result<(), String> {
    let mut st = state.lock().unwrap();
    st.custom_line = None;
    st.custom_points = None;
    Ok(())
}

/// 地图工作台底图：DEM 降采样网格 + 土类栅格 + 已有线/点叠加（均为 DEM 坐标系）
#[tauri::command]
pub async fn map_overview(state: State<'_, SharedState>, grid_w: Option<u32>) -> Result<Value, String> {
    let st = state.lock().unwrap();
    map_overview_impl(&st, grid_w)
}

pub fn map_overview_impl(st: &AppState, grid_w: Option<u32>) -> Result<Value, String> {
    let bl = blt(st);
    let dem = st.dem.as_ref().ok_or("未加载 DEM")?;
    let soil = st.soil_src.as_ref().ok_or("未加载土壤图")?;
    let g = get()?;
    let w = grid_w.unwrap_or(480).clamp(120, 1024) as i32;
    let h = ((w as f64) * (dem.ysize as f64 * dem.gt[5].abs()) / (dem.xsize as f64 * dem.gt[1])).round().max(1.0) as i32;

    unsafe {
        let mut dem_buf = vec![0f64; (w * h) as usize];
        let rc = (g.f.gdal_raster_io)(dem.band, 0, 0, 0, dem.xsize, dem.ysize,
                                      dem_buf.as_mut_ptr() as *mut std::ffi::c_void,
                                      w, h, GDT_FLOAT64, 0, 0);
        if rc != 0 {
            return Err("DEM 读取失败".into());
        }
        let cell_w = dem.gt[1] * dem.xsize as f64 / w as f64;
        let cell_h = dem.gt[5].abs() * dem.ysize as f64 / h as f64;
        let x0 = dem.gt[0] + cell_w / 2.0;
        let y0 = dem.gt[3] - cell_h / 2.0;
        let mut centers: Vec<(f64, f64)> = Vec::with_capacity((w * h) as usize);
        for r in 0..h {
            for c in 0..w {
                centers.push((x0 + c as f64 * cell_w, y0 - r as f64 * cell_h));
            }
        }
        let mut cs = centers.clone();
        transform_xy(g, dem.epsg, soil.epsg, &mut cs)?;

        // 土壤图斑包络空间哈希
        let hash_cell = (cell_w.max(cell_h) * 2.0).max(200.0);
        let mut grid: std::collections::HashMap<(i64, i64), Vec<usize>> = std::collections::HashMap::new();
        let mut tl_names: Vec<String> = Vec::new();
        let mut tl_code: std::collections::HashMap<String, u8> = std::collections::HashMap::new();
        let mut envs: Vec<(Envelope, usize)> = Vec::with_capacity(soil.feats.len());
        for (fi, f) in soil.feats.iter().enumerate() {
            if f.geom.is_null() { continue; }
            let env = f.env;
            let tl = f.attrs.get("TL").cloned().unwrap_or_default();
            let code = match tl_code.get(&tl) {
                Some(c) => *c,
                None => {
                    let c = (tl_names.len() + 1) as u8;
                    tl_names.push(tl.clone());
                    tl_code.insert(tl, c);
                    c
                }
            };
            envs.push((env, fi));
            let eidx = envs.len() - 1;
            let gx0 = (env.min_x / hash_cell).floor() as i64;
            let gx1 = (env.max_x / hash_cell).floor() as i64;
            let gy0 = (env.min_y / hash_cell).floor() as i64;
            let gy1 = (env.max_y / hash_cell).floor() as i64;
            for gx in gx0..=gx1 {
                for gy in gy0..=gy1 {
                    grid.entry((gx, gy)).or_default().push(eidx);
                }
            }
            let _ = code;
        }
        let pt_geom = (g.f.ogr_g_create_geometry)(WKB_POINT);
        let mut soil_grid = vec![0u8; (w * h) as usize];
        let mut codes = vec![0u8; soil.feats.len()];
        for (i, (cx, cy)) in cs.iter().enumerate() {
            let key = ((*cx / hash_cell).floor() as i64, (*cy / hash_cell).floor() as i64);
            if let Some(cands) = grid.get(&key) {
                (g.f.ogr_g_add_point_2d)(pt_geom, *cx, *cy);
                for &eidx in cands {
                    let (env, fi) = envs[eidx];
                    if *cx < env.min_x || *cx > env.max_x || *cy < env.min_y || *cy > env.max_y { continue; }
                    if codes[fi] == 0 {
                        let tl = soil.feats[fi].attrs.get("TL").cloned().unwrap_or_default();
                        codes[fi] = *tl_code.get(&tl).unwrap_or(&0);
                    }
                    let fgeom = soil.feats[fi].geom;
                    if (g.f.ogr_g_contains)(fgeom, pt_geom) != 0 {
                        soil_grid[i] = codes[fi];
                        break;
                    }
                }
            }
        }
        (g.f.ogr_g_destroy)(pt_geom);

        // 叠加：已加载线/点（转 DEM CRS）
        let mut lines_arr: Vec<Vec<(f64, f64)>> = Vec::new();
        if let Some(ls) = st.line_src.as_ref() {
            for f in ls.feats.iter() {
                if f.geom.is_null() { continue; }
                let mut pts: Vec<(f64, f64)> = Vec::new();
                for part in line_parts(f.geom) {
                    let mut seg = part.clone();
                    transform_xy(g, ls.epsg, Some(4326), &mut seg).ok();
                    pts.extend(seg);
                }
                lines_arr.push(pts);
            }
        }
        let mut pts_arr: Vec<(f64, f64, String)> = Vec::new();
        if let Some(ps) = st.point_src.as_ref() {
            for f in ps.feats.iter() {
                if f.geom.is_null() { continue; }
                let mut arr = [((g.f.ogr_g_get_x)(f.geom, 0), (g.f.ogr_g_get_y)(f.geom, 0))];
                transform_xy(g, ps.epsg, Some(4326), &mut arr).ok();
                let nm = ps.fields.iter().rev()
                    .find_map(|fd| f.attrs.get(fd).filter(|v| !v.is_empty()).cloned())
                    .unwrap_or_default();
                pts_arr.push((arr[0].0, arr[0].1, nm));
            }
        }
        let custom_line = st.custom_line.as_ref().map(|(parts, ep)| {
            let mut parts2 = parts.clone();
            for p in parts2.iter_mut() {
                transform_xy(g, Some(*ep), Some(4326), p).ok();
            }
            parts2.concat()
        });
        let custom_points = st.custom_points.as_ref().map(|v| {
            let mut pts: Vec<(f64, f64, String)> = v.clone();
            let ep = st.custom_line.as_ref().map(|c| c.1);
            for (x, y, _nm) in pts.iter_mut() {
                let mut arr = [(*x, *y)];
                transform_xy(g, ep, Some(4326), &mut arr).ok();
                *x = arr[0].0; *y = arr[0].1;
            }
            pts
        });

        let tl_meta: Vec<Value> = tl_names.iter().map(|t|
            json!({"name": t, "color": bl.color_of_ov("", "", "", t)})).collect();

        let dem_json: Vec<Value> = dem_buf.iter().map(|v| {
            if let Some(nd) = dem.nodata {
                if (*v - nd).abs() < 1e-6 { return Value::Null; }
            }
            json!(((*v) * 10.0).round() / 10.0)
        }).collect();

        Ok(json!({
            "w": w, "h": h,
            "bounds": [dem.gt[0], dem.gt[0] + dem.gt[1] * dem.xsize as f64,
                       dem.gt[3] + dem.gt[5] * dem.ysize as f64, dem.gt[3]],
            "epsg": dem.epsg,
            "dem": dem_json,
            "soil": soil_grid,
            "tl_meta": tl_meta,
            "lines": lines_arr, "points": pts_arr,
            "custom_line": custom_line, "custom_points": custom_points,
        }))
    }
}

#[tauri::command]
pub async fn builtin_tables(state: State<'_, SharedState>) -> Result<Value, String> {
    let st = state.lock().unwrap();
    let b = blt(&st);
    Ok(json!({"codes": b.codes, "colors": b.colors, "tl_names": b.tl_names}))
}

#[tauri::command]
pub async fn dlg_open(app: tauri::AppHandle, title: String, filter_name: String, filter_ext: String,
                      pick_dir: Option<bool>) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let strip = |p: tauri_plugin_dialog::FilePath| {
        p.to_string().trim_start_matches(r"\\?\").to_string()
    };
    if pick_dir.unwrap_or(false) {
        app.dialog().file().set_title(title).blocking_pick_folder().map(strip)
    } else {
        let exts: Vec<String> = filter_ext.split(';')
            .map(|s| s.trim().trim_start_matches("*.").trim_start_matches('*').trim().to_string())
            .filter(|s| !s.is_empty() && s != ".")
            .collect();
        let ext_refs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
        app.dialog().file()
            .set_title(title)
            .add_filter(filter_name, ext_refs.as_slice())
            .blocking_pick_file()
            .map(strip)
    }
}

#[tauri::command]
pub async fn dlg_save(app: tauri::AppHandle, title: String, default_name: String, filter_name: String, filter_ext: String) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let strip = |p: tauri_plugin_dialog::FilePath| {
        p.to_string().trim_start_matches(r"\\?\").to_string()
    };
    let exts: Vec<String> = filter_ext.split(';')
        .map(|s| s.trim().trim_start_matches("*.").trim_start_matches('*').trim().to_string())
        .filter(|s| !s.is_empty() && s != ".")
        .collect();
    let ext_refs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
    app.dialog().file()
        .set_title(title)
        .set_file_name(default_name)
        .add_filter(filter_name, ext_refs.as_slice())
        .blocking_save_file()
        .map(strip)
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_bytes_file(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}





/* ---------------- 地图数据（学习 Land Quality Optimizer：MapLibre GeoJSON 矢量 + DEM 单图） ---------------- */

/// 环坐标 → "[[x,y],...]"（坐标转 4326，6 位小数）
unsafe fn ring_coords(g: &crate::gdal_ffi::Gdal, geom: crate::gdal_ffi::HGeom, soil_epsg: Option<i32>) -> Option<String> {
    use crate::gdal_ffi::HGeom as HG;
    let pc = (g.f.ogr_g_get_point_count)(geom as HG);
    if pc == 0 { return None; }
    let mut pts: Vec<(f64, f64)> = Vec::with_capacity(pc as usize);
    for i in 0..pc {
        pts.push(((g.f.ogr_g_get_x)(geom as HG, i as i32), (g.f.ogr_g_get_y)(geom as HG, i as i32)));
    }
    if crate::pipeline::transform_xy(g, soil_epsg, Some(4326), &mut pts).is_err() { return None; }
    let body = pts.iter().map(|p| format!("[{:.6},{:.6}]", p.0, p.1)).collect::<Vec<_>>().join(",");
    Some(format!("[{}]", body))
}

/// 几何 → GeoJSON geometry 文本（Polygon/MultiPolygon/LineString）
unsafe fn geom_to_geojson(g: &crate::gdal_ffi::Gdal, geom: crate::gdal_ffi::HGeom, soil_epsg: Option<i32>) -> Option<String> {
    use crate::gdal_ffi::HGeom as HG;
    let gm = geom as HG;
    let gc = (g.f.ogr_g_get_geometry_count)(gm);
    let pc = (g.f.ogr_g_get_point_count)(gm);
    if gc == 0 && pc > 0 {
        // 线兜底
        let cs = ring_coords(g, gm, soil_epsg)?;
        return Some(format!("{{\"type\":\"LineString\",\"coordinates\":{}}}", &cs[1..cs.len() - 1]));
    }
    if gc == 0 { return None; }
    let mut rings: Vec<String> = Vec::new();
    let mut polys: Vec<String> = Vec::new();
    for i in 0..gc {
        let sub = (g.f.ogr_g_get_geometry_ref)(gm, i as i32);
        if sub.is_null() { continue; }
        let sub_gc = (g.f.ogr_g_get_geometry_count)(sub);
        let sub_pc = (g.f.ogr_g_get_point_count)(sub);
        if sub_gc > 0 {
            // 嵌套：MultiPolygon 成员 → 递归聚合 ring
            let mut prings: Vec<String> = Vec::new();
            for j in 0..sub_gc {
                let rr = (g.f.ogr_g_get_geometry_ref)(sub, j as i32);
                if rr.is_null() { continue; }
                if (g.f.ogr_g_get_point_count)(rr) > 0 {
                    if let Some(rc) = ring_coords(g, rr, soil_epsg) { prings.push(rc); }
                }
            }
            if !prings.is_empty() {
                polys.push(format!("[{}]", prings.join(",")));
            }
        } else if sub_pc > 0 {
            if let Some(rc) = ring_coords(g, sub, soil_epsg) { rings.push(rc); }
        }
    }
    if !polys.is_empty() {
        Some(format!("{{\"type\":\"MultiPolygon\",\"coordinates\":[{}]}}", polys.join(",")))
    } else if !rings.is_empty() {
        Some(format!("{{\"type\":\"Polygon\",\"coordinates\":[{}]}}", rings.join(",")))
    } else { None }
}

/// 全量土壤图 → GeoJSON（4326，属性 TL/YL/TS/TZ/ADMIN/LITH；前端 MapLibre fill 矢量渲染）
/// 线/点图层坐标提取（转 4326 注入地图）；返回 LineString/MultiLineString 与 Point 集合
#[tauri::command]
pub async fn layer_geojson(state: State<'_, SharedState>, kind: String) -> Result<Value, String> {
    let st = state.lock().unwrap();
    let g = get()?;
    let src = if kind == "line" { st.line_src.as_ref() } else { st.point_src.as_ref() };
    let src = src.ok_or("未装载图层")?;
    let mut lines: Vec<Vec<(f64, f64)>> = Vec::new();
    let mut pts: Vec<(f64, f64, String)> = Vec::new();
    unsafe {
        for f in src.feats.iter() {
            if f.geom.is_null() { continue; }
            let gc = (g.f.ogr_g_get_geometry_count)(f.geom);
            let pc = (g.f.ogr_g_get_point_count)(f.geom);
            if kind == "line" {
                // 线要素：取每部分折线
                let collect = |geom: crate::gdal_ffi::HGeom, out: &mut Vec<(f64, f64)>| {
                    let n = (g.f.ogr_g_get_point_count)(geom);
                    for i in 0..n {
                        out.push(((g.f.ogr_g_get_x)(geom, i as i32), (g.f.ogr_g_get_y)(geom, i as i32)));
                    }
                };
                if gc == 0 && pc > 0 {
                    let mut seg = Vec::new();
                    collect(f.geom, &mut seg);
                    if seg.len() >= 2 { lines.push(seg); }
                } else {
                    for i in 0..gc {
                        let sub = (g.f.ogr_g_get_geometry_ref)(f.geom, i as i32);
                        if sub.is_null() { continue; }
                        let mut seg = Vec::new();
                        collect(sub, &mut seg);
                        if seg.len() >= 2 { lines.push(seg); }
                    }
                }
            } else {
                let (x, y) = ((g.f.ogr_g_get_x)(f.geom, 0), (g.f.ogr_g_get_y)(f.geom, 0));
                let nm = src.fields.iter().rev()
                    .find_map(|fd| f.attrs.get(fd).filter(|v| !v.is_empty()).cloned())
                    .unwrap_or_default();
                pts.push((x, y, nm));
            }
        }
    }
    if kind == "line" {
        for seg in lines.iter_mut() {
            let _ = transform_xy(g, src.epsg, Some(4326), seg);
        }
    } else {
        let mut p2: Vec<(f64, f64)> = pts.iter().map(|p| (p.0, p.1)).collect();
        let _ = transform_xy(g, src.epsg, Some(4326), &mut p2);
        for (i, p) in pts.iter_mut().enumerate() { p.0 = p2[i].0; p.1 = p2[i].1; }
    }
    Ok(json!({ "lines": lines, "points": pts }))
}

#[tauri::command]
pub async fn get_soil_geojson(state: State<'_, SharedState>) -> Result<Value, String> {
    let st = state.lock().unwrap();
    get_soil_geojson_impl(&st)
}

pub fn get_soil_geojson_impl(st: &AppState) -> Result<Value, String> {
    let g = get()?;
    let soil = st.soil_src.as_ref().ok_or("未加载土壤图")?;
    let mut feats: Vec<String> = Vec::with_capacity(soil.feats.len());
    unsafe {
        for (fi, f) in soil.feats.iter().enumerate() {
            if f.geom.is_null() { continue; }
            let geo = geom_to_geojson(g, f.geom, soil.epsg);
            let geo = match geo { Some(v) => v, None => continue };
            let a = |k: &str| f.attrs.get(k).cloned().unwrap_or_default();
            let tl_raw = a("TL");
            let esc = |v: String| v.replace('\\', "\\\\").replace('"', "\\\"");
            let props = format!(
                "{{\"no\":{},\"tl\":\"{}\",\"yl\":\"{}\",\"ts\":\"{}\",\"tz\":\"{}\",\"admin\":\"{}\",\"lith\":\"{}\",\"color\":\"{}\"}}",
                fi,
                esc(tl_raw.clone()),
                esc(a("YL")),
                esc(a("TS")),
                esc(a("TZ")),
                esc(a("ADMIN")),
                esc(a("LITH")),
                blt(st).color_of_ov(&tl_raw, "", "", ""),
            );
            feats.push(format!("{{\"type\":\"Feature\",\"properties\":{},\"geometry\":{}}}", props, geo));
        }
    }
    // bounds（4326，全体图斑包络聚合）
    let mut bx0 = f64::MAX; let mut by0 = f64::MAX; let mut bx1 = -f64::MAX; let mut by1 = -f64::MAX;
    for f in soil.feats.iter() {
        if f.geom.is_null() { continue; }
        bx0 = bx0.min(f.env.min_x); by0 = by0.min(f.env.min_y);
        bx1 = bx1.max(f.env.max_x); by1 = by1.max(f.env.max_y);
    }
    if bx0 > bx1 { bx0 = 0.0; by0 = 0.0; bx1 = 1.0; by1 = 1.0; }
    let mut b = [(bx0, by0), (bx1, by1)];
    let _ = transform_xy(g, soil.epsg, Some(4326), &mut b);
    let b4 = [b[0].0.min(b[1].0), b[0].1.min(b[1].1), b[0].0.max(b[1].0), b[0].1.max(b[1].1)];
    Ok(json!({
        "count": feats.len(),
        "bounds": b4,
        "geojson": format!("{{\"type\":\"FeatureCollection\",\"features\":[{}]}}", feats.join(",")),
    }))
}

pub struct DemImage {
    pub png: Arc<Vec<u8>>,
    pub bounds: [f64; 4],     // 4326
    pub e_range: (f64, f64),
    pub w: u32, pub h: u32,
}
unsafe impl Send for DemImage {}
unsafe impl Sync for DemImage {}

/// DEM 全图单次渲染（高程色带 + 山体阴影 → PNG；MapLibre image source，GPU 缩放）
#[tauri::command]
pub async fn get_dem_image(state: State<'_, SharedState>) -> Result<Value, String> {
    let mut st = state.lock().unwrap();
    get_dem_image_impl_mut(&mut st)
}

pub fn get_dem_image_impl(st: &AppState) -> Result<Value, String> {
    if let Some(di) = st.dem_image.as_ref() {
        return Ok(json!({ "bounds": di.bounds, "e_range": [di.e_range.0, di.e_range.1], "w": di.w, "h": di.h, "cached": true }));
    }
    let di = build_dem_image(st)?;
    Ok(json!({ "bounds": di.bounds, "e_range": [di.e_range.0, di.e_range.1], "w": di.w, "h": di.h, "cached": false }))
}

fn get_dem_image_impl_mut(st: &mut AppState) -> Result<Value, String> {
    if let Some(di) = st.dem_image.as_ref() {
        return Ok(json!({ "bounds": di.bounds, "e_range": [di.e_range.0, di.e_range.1], "w": di.w, "h": di.h, "cached": true }));
    }
    let di = build_dem_image(st)?;
    let meta = json!({ "bounds": di.bounds, "e_range": [di.e_range.0, di.e_range.1], "w": di.w, "h": di.h, "cached": false });
    st.dem_image = Some(di);
    Ok(meta)
}

#[tauri::command]
pub async fn get_dem_png(state: State<'_, SharedState>) -> Result<tauri::ipc::Response, String> {
    let mut st = state.lock().unwrap();
    if st.dem_image.is_none() {
        let di = build_dem_image(&st)?;
        st.dem_image = Some(di);
    }
    let png = st.dem_image.as_ref().unwrap().png.clone();
    Ok(tauri::ipc::Response::new(png.as_slice().to_vec()))
}

fn build_dem_image(st: &AppState) -> Result<DemImage, String> {
    let g = get()?;
    let dem = st.dem.as_ref().ok_or("未加载 DEM")?;
    let w = 2048u32.min(dem.xsize.max(256) as u32);
    let h = ((w as f64) * (dem.ysize as f64) / (dem.xsize as f64)).round().max(64.0) as u32;
    unsafe {
        let mut buf = vec![0f64; (w * h) as usize];
        let rc = (g.f.gdal_raster_io)(dem.band, 0, 0, 0, dem.xsize, dem.ysize,
            buf.as_mut_ptr() as *mut std::ffi::c_void, w as i32, h as i32, GDT_FLOAT64, 0, 0);
        if rc != 0 { return Err("DEM 读取失败".into()); }
        let (mut lo, mut hi) = (f64::MAX, f64::MIN);
        for v in buf.iter() {
            if v.is_nan() || dem.nodata.map(|nd| (v - nd).abs() < 1e-6).unwrap_or(false) { continue; }
            lo = lo.min(*v); hi = hi.max(*v);
        }
        if lo > hi { lo = 0.0; hi = 1.0; }
        let e_span = (hi - lo).max(1e-6);
        const RAMP: [[f64; 3]; 6] = [[38., 92., 58.], [92., 140., 62.], [168., 186., 90.], [214., 196., 118.], [176., 138., 90.], [222., 214., 198.]];
        let mut rgba = vec![255u8; (w * h * 4) as usize];
        let cw = (dem.gt[1] * dem.xsize as f64) / w as f64;
        let ch = (dem.gt[5].abs() * dem.ysize as f64) / h as f64;
        let zs = |r: usize, c: usize| buf.get(r * w as usize + c).copied().unwrap_or(f64::NAN);
        for r in 0..h as usize {
            for c in 0..w as usize {
                let i = (r * w as usize + c) * 4;
                let e = buf[r * w as usize + c];
                if e.is_nan() || dem.nodata.map(|nd| (e - nd).abs() < 1e-6).unwrap_or(false) {
                    rgba[i] = 250; rgba[i + 1] = 250; rgba[i + 2] = 248;
                    continue;
                }
                let dzdx = (zs(r, (c + 1).min(w as usize - 1)) - zs(r, c.saturating_sub(1))) / (2.0 * cw);
                let dzdy = (zs((r + 1).min(h as usize - 1), c) - zs(r.saturating_sub(1), c)) / (2.0 * ch);
                let slope = std::f64::consts::FRAC_PI_2 - dzdx.hypot(dzdy).atan();
                let aspect = dzdx.atan2(-dzdy);
                let mut hs0 = 0.7071 * slope.sin() + 0.7071 * slope.cos() * (5.4978 - aspect).cos();
                if hs0.is_nan() { hs0 = 0.62; }
                hs0 = hs0.clamp(0.35, 1.08);
                let t = ((e - lo) / e_span).clamp(0.0, 0.9999) * (RAMP.len() - 1) as f64;
                let k = t.floor() as usize;
                let f2 = t - k as f64;
                let (a2, b2) = (RAMP[k], RAMP[(k + 1).min(RAMP.len() - 1)]);
                let mixc = |x: f64, y: f64| x + (y - x) * f2;
                rgba[i] = (mixc(a2[0], b2[0]) * hs0) as u8;
                rgba[i + 1] = (mixc(a2[1], b2[1]) * hs0) as u8;
                rgba[i + 2] = (mixc(a2[2], b2[2]) * hs0) as u8;
            }
        }
        let png = rgba_to_png_w(&rgba, w as u32, h as u32);
        let mut b = [(dem.gt[0], dem.gt[3] + dem.gt[5] * dem.ysize as f64),
                     (dem.gt[0] + dem.gt[1] * dem.xsize as f64, dem.gt[3])];
        let _ = transform_xy(g, dem.epsg, Some(4326), &mut b);
        Ok(DemImage {
            png: Arc::new(png),
            bounds: [b[0].0.min(b[1].0), b[0].1.min(b[1].1), b[0].0.max(b[1].0), b[0].1.max(b[1].1)],
            e_range: (lo, hi), w, h,
        })
    }
}

fn rgba_to_png_w(rgba: &[u8], w: u32, h: u32) -> Vec<u8> {
    let mut png = Vec::with_capacity(rgba.len() / 3);
    {
        let mut enc = png::Encoder::new(&mut png, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut wr = enc.write_header().expect("png header");
        wr.write_image_data(rgba).expect("png rows");
    }
    png
}
