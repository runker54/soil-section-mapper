//! 全功能自测：模拟前端完整调用链，输出 PASS/FAIL 清单并导出前端测试夹具。
use serde_json::json;
use soil_section_studio::commands::{
    compute_impl, map_overview_impl, use_dem_impl, use_line_impl, use_points_impl,
    use_soil_impl, AppState,
};
use soil_section_studio::gdal_ffi;
use soil_section_studio::pipeline::use_layer;

fn check(name: &str, cond: bool, extra: &str) -> bool {
    println!("{} {:<38} {}", if cond { "✔" } else { "✘" }, name, extra);
    cond
}

fn main() {
    let base = r"E:\zcode_worker\土壤类型断面图";
    let gdal_dir = base.to_string() + r"\app_gdal_env\Lib\site-packages\rasterio.libs";
    let mut pass = 0; let mut total = 0;
    macro_rules! ck { ($n:expr, $c:expr, $e:expr) => { total += 1; if check($n, $c, $e) { pass += 1; } } }

    // 1 GDAL 初始化
    let g = match gdal_ffi::init(&gdal_dir) { Ok(g) => g, Err(e) => { println!("GDAL init FAIL: {}", e); return; } };
    ck!("gdal_init", g.version().starts_with("GDAL"), &g.version());

    let mut st = AppState { builtin2: None, line_src: None, point_src: None, soil_src: None, dem: None, custom_line: None, custom_points: None, dem_image: None };

    // 2 图层枚举
    let layers = tauri::async_runtime::block_on(soil_section_studio::commands::vector_layers(base.to_string() + r"\安龙县断面点加密.gdb")).unwrap();
    ck!("vector_layers(gdb)", layers.len() == 2, &format!("{} 层", layers.len()));

    // 3 数据装载（含字段映射）
    let r_line = use_line_impl(&mut st, &(base.to_string() + r"\安龙县断面点加密.gdb"), "alx线合并").unwrap();
    ck!("use_line_impl", r_line["lines"].as_array().unwrap().len() == 7, &format!("{} 条线", r_line["lines"].as_array().unwrap().len()));
    let r_pts = use_points_impl(&mut st, &(base.to_string() + r"\安龙县断面点加密.gdb"), "alx点合并").unwrap();
    ck!("use_points_impl", r_pts["count"] == 53, "");
    let r_soil = use_soil_impl(&mut st, &(base.to_string() + r"\alx.gdb"), "三普土壤类型图",
                               "TL", "YL", "TS", "TZ", "", "").unwrap();
    ck!("use_soil_impl", r_soil["count"] == 20246, "");
    let r_dem = use_dem_impl(&mut st, &(base.to_string() + r"\dem.tif")).unwrap();
    ck!("use_dem_impl", r_dem["xsize"] == 2267 && r_dem["epsg"] == 4544, &format!("EPSG:{}", r_dem["epsg"]));

    // 4 内置表（含覆盖合并逻辑：默认即内置）
    let bt = { let b = soil_section_studio::commands::blt(&st);
        json!({"codes": b.codes.clone(), "colors": b.colors.clone()}) };
    ck!("builtin_tables", bt["codes"].as_array().unwrap().len() == 1329
        && bt["colors"].as_array().unwrap().len() == 1505, "");

    // 5 文件模式计算（含界线名称自动配色：color_key 留空，仅名称“黄壤带”）
    let req = json!({
        "sample_interval_m": 50.0, "smoothing": 5,
        "orientation": "high_left", "ve": null, "line_index": 0,
        "point_name_field": "地点名称", "point_no_field": "编号",
        "point_filter": {"mode": "field", "field": "线", "value": "1", "max_dist_m": 600.0},
        "zones": [
            {"elev": 600.0, "name": "红壤带", "color_key": ""},
            {"elev": 800.0, "name": "黄壤带", "color_key": ""},
            {"elev": 1600.0, "name": "黄棕壤带", "color_key": ""}
        ],
        "points_override": []
    });
    let res = compute_impl(&st, req).unwrap();
    ck!("compute(文件模式)", res["total_km"].as_f64().unwrap() > 50.0
        && res["points"].as_array().unwrap().len() == 10,
        &format!("{:.2}km {}点 VE{}", res["total_km"], res["points"].as_array().unwrap().len(), res["ve"]));
    let zones = res["zones"].as_array().unwrap();
    let z800 = zones.iter().find(|z| z["elev"] == 800.0).unwrap();
    ck!("界线名称自动配色", z800["color"].as_str().unwrap_or("").starts_with("#") && z800["color"] != "#cccccc",
        &format!("黄壤带 -> {}", z800["color"]));

    // 6 表格覆盖：改地名/海拔、删点、加点
    let pts = res["points"].as_array().unwrap().clone();
    let mut ov = pts.iter().map(|p| json!({
        "no": p["no"], "name": p["name"], "elev": p["elev"], "ch_km": p["ch_km"],
        "code": p["code"], "tz": p["tz"], "ts": p["ts"], "yl": p["yl"], "tl": p["tl"],
        "admin": "", "lith": "", "color": ""
    })).collect::<Vec<_>>();
    ov.retain(|p| p["no"] != 5);                       // 删 5 号点（巷洞街）
    let p1 = ov.iter_mut().find(|p| p["no"] == 1).unwrap();
    p1["name"] = json!("者干改名"); p1["elev"] = json!(480.0);
    ov.push(json!({"no": 99, "name": "新增测试点", "elev": 1200.0, "ch_km": 10.0,
                   "code": "1043", "tz": "均黏壤灰潮土", "ts": "灰潮土", "yl": "灰潮土", "tl": "潮土",
                   "admin": "", "lith": "", "color": ""}));
    let req2 = json!({
        "sample_interval_m": 50.0, "smoothing": 5, "orientation": "high_left",
        "ve": null, "line_index": 0,
        "point_name_field": "地点名称", "point_no_field": "编号",
        "point_filter": {"mode": "field", "field": "线", "value": "1", "max_dist_m": 600.0},
        "zones": [], "points_override": ov
    });
    let res2 = compute_impl(&st, req2).unwrap();
    let names: Vec<&str> = res2["points"].as_array().unwrap().iter()
        .map(|p| p["name"].as_str().unwrap_or("")).collect();
    ck!("表格覆盖(改名/删点/加点)", names.contains(&"者干改名") && !names.contains(&"巷洞街")
        && names.contains(&"新增测试点") && names.len() == 10,
        &names.iter().filter(|n| **n == "新增测试点" || **n == "者干改名").count().to_string());

    // 7 地图总览
    let mo = map_overview_impl(&st, Some(320)).unwrap();
    let soil_cov = mo["soil"].as_array().unwrap().iter().filter(|v| v.as_u64().unwrap_or(0) > 0).count();
    ck!("map_overview", mo["w"] == 320 && soil_cov > 1000
        && mo["tl_meta"].as_array().unwrap().len() >= 9,
        &format!("{}x{} 土类覆盖{}格", mo["w"], mo["h"], soil_cov));

    // 7.5 点选图斑查询（底图中心点）
    {
        let b = mo["bounds"].as_array().unwrap();
        let (x0, x1) = (b[0].as_f64().unwrap(), b[1].as_f64().unwrap());
        let (y0, y1) = (b[2].as_f64().unwrap(), b[3].as_f64().unwrap());
        let q = soil_section_studio::commands::soil_query_impl(&st, (x0 + x1) / 2.0, (y0 + y1) / 2.0, Some(4544)).unwrap();
        ck!("soil_query(中心点)", q["found"].as_bool().unwrap_or(false),
            &format!("{}{}", q["tl"].as_str().unwrap_or(""), if q["elev"].is_null() { " 无DEM" } else { " 含高程" }));
    }

    // 7.7 地图数据：土壤 GeoJSON + DEM 单图
    {
        let r = soil_section_studio::commands::get_soil_geojson_impl(&st).unwrap();
        let gj = r["geojson"].as_str().unwrap_or("");
        let color_hits = gj.matches("\"color\":\"#").count();
        ck!("soil_geojson", r["count"].as_u64().unwrap_or(0) > 1000
            && gj.contains("FeatureCollection") && color_hits > 1000,
            &format!("{} 要素 · {} 个着色属性 · bounds {:?}", r["count"], color_hits, r["bounds"]));
        let di = soil_section_studio::commands::get_dem_image_impl(&st).unwrap();
        ck!("dem_image", di["w"].as_u64().unwrap_or(0) >= 512, &format!("{}x{} 极值 {:?}", di["w"], di["h"], di["e_range"]));
    }

    // 8 自定义线/点（取安龙县级线的首尾与中点重采样做绘制模拟）
    let pts_line = use_layer(&(base.to_string() + r"\安龙县断面点加密.gdb"), "alx线合并").unwrap();
    let _ = pts_line;
    // 自定义线：直接复用第一条线的前后各一顶点 + 用 3 个粗略点模拟手绘
    let custom_line_pts: Vec<(f64, f64)> = {
        // 从 map bounds 反推几个 DEM 坐标点（简单横穿线）
        let b = mo["bounds"].as_array().unwrap();
        let (x0, x1) = (b[0].as_f64().unwrap(), b[1].as_f64().unwrap());
        let (y0, y1) = (b[2].as_f64().unwrap(), b[3].as_f64().unwrap());
        vec![(x0 + (x1 - x0) * 0.3, (y0 + y1) / 2.0),
             (x0 + (x1 - x0) * 0.5, (y0 + y1) / 2.0 + 3000.0),
             (x0 + (x1 - x0) * 0.7, (y0 + y1) / 2.0)]
    };
    st.custom_line = Some((vec![custom_line_pts.clone()], 4544));
    st.custom_points = Some(vec![
        (custom_line_pts[0].0, custom_line_pts[0].1, "西端".to_string()),
        (custom_line_pts[2].0, custom_line_pts[2].1, "东端".to_string()),
    ]);
    let req3 = json!({
        "use_custom": true,
        "sample_interval_m": 50.0, "smoothing": 5, "orientation": "high_left", "ve": null,
        "zones": [], "points_override": []
    });
    // 8.55 跨源 override 污染（复现：文件点 + 旧自绘 override → 大部分点被丢弃）
    {
        let ro = compute_impl(&st, json!({ "use_custom": false, "sample_interval_m": 50.0, "smoothing": 5,
            "orientation": "high_left", "ve": null, "zones": [],
            "points_override": [
                json!({ "no": 1, "name": "旧自绘A1", "ch_km": 0.0, "elev": 100.0 }),
                json!({ "no": 2, "name": "旧自绘A2", "ch_km": 1.0, "elev": 200.0 }),
            ] })).unwrap();
        let n_pol = ro["points"].as_array().unwrap().len();
        ck!("跨源override污染(复现)", n_pol < 10, &format!("文件本 10 点仅剩 {} 点——前端源切换已清空 override 规避", n_pol));
    }

    // 8.6 剖面切换序列：A线+A2点 → B线+B3点 → B线+空点（表格同步依赖）
    {
        let mut pa: Vec<(f64, f64)> = vec![(105.10, 25.10), (105.20, 25.10)];
        let ep = soil_section_studio::commands::geo_to_metric(g, &mut pa, 4326).unwrap();
        st.custom_line = Some((vec![pa.clone()], ep));
        st.custom_points = Some(vec![(pa[0].0, pa[0].1, "A1".into()), (pa[1].0, pa[1].1, "A2".into())]);
        let ra = compute_impl(&st, json!({ "use_custom": true, "sample_interval_m": 50.0, "smoothing": 3,
            "orientation": "high_left", "ve": null, "zones": [], "points_override": [] })).unwrap();
        let na = ra["points"].as_array().unwrap();
        ck!("剖面A(2点)", na.len() == 2 && na[0]["name"] == "A1", &format!("{}点 首点{}", na.len(), na[0]["name"]));

        let mut pb: Vec<(f64, f64)> = vec![(105.30, 25.20), (105.40, 25.22), (105.50, 25.20)];
        let _ = soil_section_studio::commands::geo_to_metric(g, &mut pb, 4326).unwrap();
        st.custom_line = Some((vec![pb.clone()], ep));
        st.custom_points = Some(vec![(pb[0].0, pb[0].1, "B1".into()), (pb[1].0, pb[1].1, "B2".into()), (pb[2].0, pb[2].1, "B3".into())]);
        let rb = compute_impl(&st, json!({ "use_custom": true, "sample_interval_m": 50.0, "smoothing": 3,
            "orientation": "high_left", "ve": null, "zones": [], "points_override": [] })).unwrap();
        let nb = rb["points"].as_array().unwrap();
        ck!("剖面B(3点)", nb.len() == 3 && nb[0]["name"] == "B1", &format!("{}点 首点{} 总长{:.1}km", nb.len(), nb[0]["name"], rb["total_km"].as_f64().unwrap_or(0.0)));

        st.custom_points = None;   // B 剖面清空点（仅线）→ 后端应明确报错（前端已前置校验）
        let rc = compute_impl(&st, json!({ "use_custom": true, "sample_interval_m": 50.0, "smoothing": 3,
            "orientation": "high_left", "ve": null, "zones": [], "points_override": [] }));
        ck!("剖面B清空点(报错语义)", rc.is_err() && rc.unwrap_err().contains("布点"), "无点剖面明确报错");
        // 恢复 B 的点（供后续旧用例）
        st.custom_points = Some(vec![(pb[0].0, pb[0].1, "B1".into()), (pb[1].0, pb[1].1, "B2".into()), (pb[2].0, pb[2].1, "B3".into())]);
    }

    let res3 = compute_impl(&st, req3).unwrap();
    let cp = res3["points"].as_array().unwrap();
    ck!("compute(自定义线点)", cp.len() == 3
        && cp.iter().all(|p| !p["tz"].as_str().unwrap_or("").is_empty()),
        &format!("{}点 首点土种={}", cp.len(), cp[0]["tz"].as_str().unwrap_or("")));

    // 9 导出夹具（供前端 Playwright mock 使用）
    let fx_dir = base.to_string() + r"\soil-section-studio\test-fixtures";
    std::fs::create_dir_all(&fx_dir).unwrap();
    std::fs::write(fx_dir.clone() + r"\compute_file.json", serde_json::to_vec(&res).unwrap()).unwrap();
    std::fs::write(fx_dir.clone() + r"\map_overview.json", serde_json::to_vec(&mo).unwrap()).unwrap();
    let meta = json!({
        "line_meta": r_line, "points_meta": r_pts, "soil_meta": r_soil, "dem_meta": r_dem,
        "layers": layers, "builtin": bt
    });
    // 8.5 自绘线 4326 → 三度带自动转换（geo_to_metric 回归）
    {
        let mut lln: Vec<(f64, f64)> = vec![(105.10, 25.10), (105.20, 25.12), (105.30, 25.10)];
        let ep = soil_section_studio::commands::geo_to_metric(g, &mut lln, 4326).unwrap();
        let len_m: f64 = lln.windows(2).map(|w| (w[1].0 - w[0].0).hypot(w[1].1 - w[0].1)).sum();
        let mut pl = vec![(105.10, 25.10), (105.30, 25.10)];
        let _ = soil_section_studio::commands::geo_to_metric(g, &mut pl, 4326).unwrap();
        st.custom_line = Some((vec![lln], ep));
        st.custom_points = Some(vec![(pl[0].0, pl[0].1, "西端".into()), (pl[1].0, pl[1].1, "东端".into())]);
        let res4 = compute_impl(&st, json!({ "use_custom": true, "sample_interval_m": 50.0, "smoothing": 5,
            "orientation": "high_left", "ve": null, "zones": [], "points_override": [] })).unwrap();
        let km = res4["total_km"].as_f64().unwrap_or(0.0);
        ck!("自绘线(4326→三度带)", len_m > 15000.0 && km > 15.0,
            &format!("米制 {:.1}km → 断面 {:.1}km", len_m / 1000.0, km));
    }

    std::fs::write(fx_dir + r"\metas.json", serde_json::to_vec(&meta).unwrap()).unwrap();

    println!("\n===== 全功能自测: {}/{} PASS =====", pass, total);
    if pass != total { std::process::exit(1); }
}
