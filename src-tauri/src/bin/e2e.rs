//! 端到端验证：用安龙真实数据跑完整计算管线，输出与 Python 版比对的关键数值。
use serde_json::json;
use soil_section_studio::commands::{compute_impl, AppState};
use soil_section_studio::pipeline::{open_dem, use_layer};
use soil_section_studio::gdal_ffi;


fn main() {
    let base = r"E:\zcode_worker\土壤类型断面图";
    let gdal_dir = base.to_string() + r"\app_gdal_env\Lib\site-packages\rasterio.libs";
    let g = gdal_ffi::init(&gdal_dir).expect("gdal init");
    println!("GDAL: {}", g.version());

    let mut st = AppState { builtin2: None, line_src: None, point_src: None, soil_src: None, dem: None, custom_line: None, custom_points: None, dem_image: None };
    let line = use_layer(&(base.to_string() + r"\安龙县断面点加密.gdb"), "alx线合并").unwrap();
    println!("线: {} 要素 EPSG:{:?}", line.feats.len(), line.epsg);
    let pts = use_layer(&(base.to_string() + r"\安龙县断面点加密.gdb"), "alx点合并").unwrap();
    println!("点: {} 要素 EPSG:{:?}", pts.feats.len(), pts.epsg);
    let soil = use_layer(&(base.to_string() + r"\alx.gdb"), "三普土壤类型图").unwrap();
    println!("土壤图: {} 要素 EPSG:{:?}", soil.feats.len(), soil.epsg);
    st.line_src = Some(line);
    st.point_src = Some(pts);
    st.soil_src = Some(soil);
    let dem = open_dem(&(base.to_string() + r"\dem.tif")).unwrap();
    println!("DEM: {}x{} EPSG:{:?} {}~{}m", dem.xsize, dem.ysize, dem.epsg, dem.emin as i32, dem.emax as i32);
    st.dem = Some(dem);

    // 线索引：备注含“2-1-1”的县级线。列出全部线让用户可见。
    {
        let ls = st.line_src.as_ref().unwrap();
        for (i, f) in ls.feats.iter().enumerate() {
            println!("  line[{}] 备注={:?} 编号字段={:?}", i,
                     f.attrs.get("备注").map(|s| s.as_str()),
                     f.attrs.get("Name").map(|s| s.as_str()));
        }
    }

    let req = json!({
        "sample_interval_m": 50.0,
        "smoothing": 5,
        "orientation": "high_left",
        "ve": null,
        "line_index": 0,
        "point_name_field": "地点名称",
        "point_no_field": "编号",
        "point_filter": {"mode": "field", "field": "线", "value": "1", "max_dist_m": 600.0},
        "zones": [
            {"elev": 600.0, "name": "红壤带", "color_key": "红壤"},
            {"elev": 800.0, "name": "黄壤带", "color_key": "黄壤"},
            {"elev": 1600.0, "name": "黄棕壤带", "color_key": "黄棕壤"}
        ],
        "points_override": []
    });

    let res = compute_impl(&st, req).unwrap();
    println!("\n=== 图2-1-1 县级断面 ===");
    println!("total_km={:.3}  samples={}  ve={}  az={:.1}° {}  flip={}",
             res["total_km"].as_f64().unwrap(), res["sample_count"],
             res["ve"], res["azimuth"].as_f64().unwrap(), res["wind"].as_str().unwrap(), res["flip"]);
    println!("elev {:.1}~{:.1}  y_base={}", res["elev_min"], res["elev_max"], res["y_base"]);
    println!("zones drawn: {:?}", res["zones"]);
    for p in res["points"].as_array().unwrap() {
        println!("  点{:>2} {:<6} ch={:7.3}km elev={:7.1} code={:<5} tz={} color={}",
                 p["no"].as_i64().unwrap(), p["name"].as_str().unwrap_or(""),
                 p["ch_km"].as_f64().unwrap(), p["elev"].as_f64().unwrap(),
                 p["code"].as_str().unwrap_or(""), p["tz"].as_str().unwrap_or(""), p["color"].as_str().unwrap_or(""));
    }
    println!("E2E PASS");
}
