//! 库入口：模块导出 + Tauri 应用启动。
pub mod builtin;
pub mod commands;
pub mod gdal_ffi;
pub mod pipeline;

pub fn run() {
    // WebView2 用户数据（缓存等）重定向到 exe 旁 temp/，避免写入 C 盘用户目录
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let tmp = dir.join("temp");
            let _ = std::fs::create_dir_all(&tmp);
            std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &tmp);
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(std::sync::Mutex::new(commands::AppState {
            builtin2: None,
            county: None,
            line_src: None,
            point_src: None,
            soil_src: None,
            dem: None,
            custom_line: None,
            custom_points: None,
            dem_image: None,
        }))
        .invoke_handler(tauri::generate_handler![
            commands::gdal_init,
            commands::gdal_default_dir,
            commands::vector_layers,
            commands::use_line,
            commands::use_points,
            commands::use_soil,
            commands::use_dem,
            commands::compute_section,
            commands::import_builtin,
            commands::reset_builtin,
            commands::set_custom_line,
            commands::set_custom_points,
            commands::clear_custom,
            commands::map_overview,
            commands::layer_geojson,
            commands::get_soil_geojson,
            commands::get_dem_image,
            commands::get_dem_png,
            commands::soil_query,
            commands::builtin_tables,
            commands::dlg_open,
            commands::dlg_save,
            commands::write_text_file,
            commands::write_bytes_file,
            commands::read_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
