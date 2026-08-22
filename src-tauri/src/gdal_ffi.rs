//! GDAL 动态加载 FFI：运行时加载项目专属 GDAL DLL（便携、零编译期原生依赖）。
//! API 签名已通过 ctypes 冒烟测试验证（GDAL 3.10.3 / OpenFileGDB / OSR / GeoTIFF）。
#![allow(non_snake_case)]

use libloading::{Library, Symbol};
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub type HDataset = *mut c_void;
pub type HLayer = *mut c_void;
pub type HFeature = *mut c_void;
pub type HGeom = *mut c_void;
pub type HSRS = *mut c_void;
pub type HCT = *mut c_void;
pub type HBand = *mut c_void;

pub const OF_READONLY: u32 = 0x00;
pub const OF_UPDATE: u32 = 0x01;
pub const OF_RASTER: u32 = 0x02;
pub const OF_VECTOR: u32 = 0x04;
pub const WKB_POINT: u32 = 1;
pub const GDT_FLOAT64: u32 = 7;
// 实测(rasterio 打包 GDAL 3.10.3)：OSRSetAxisMappingStrategy 传 0 时按传统 (x=lon,y=lat) 顺序工作；
// 传 2(OAMS_TRADITIONAL_GIS_ORDER 标准值) 反而触发权威 (lat,lon) 顺序导致 4326->投影 失败。
pub const OAMS_TRADITIONAL_GIS_ORDER: i32 = 0;

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Envelope {
    pub min_x: f64,
    pub max_x: f64,
    pub min_y: f64,
    pub max_y: f64,
}

macro_rules! fns {
    ($( $field:ident = $name:ident : fn ( $($arg:ty),* ) -> $ret:ty ; )*) => {
        pub struct Fns {
            $( pub $field: unsafe extern "C" fn ($($arg),*) -> $ret, )*
        }
        unsafe impl Send for Fns {}
        unsafe impl Sync for Fns {}

        fn load_all(lib: &'static Library) -> Result<Fns, String> {
            Ok(Fns {
                $( $field: unsafe {
                    let s: Symbol<unsafe extern "C" fn ($($arg),*) -> $ret> =
                        lib.get(concat!(stringify!($name), "\0").as_bytes())
                           .map_err(|e| format!("缺少导出函数 {}: {}", stringify!($name), e))?;
                    *s
                }, )*
            })
        }
    };
}

fns! {
    cpl_set_config = CPLSetConfigOption : fn (*const u8, *const u8) -> ();
    cpl_get_last_err_msg = CPLGetLastErrorMsg : fn () -> *const u8;
    gdal_version_info = GDALVersionInfo : fn (*const u8) -> *const u8;
    gdal_all_register = GDALAllRegister : fn () -> ();

    gdal_open_ex = GDALOpenEx : fn (*const u8, u32, *const *const u8, *const *const u8, *const *const u8) -> HDataset;
    gdal_close = GDALClose : fn (HDataset) -> ();
    gdal_get_layer_count = GDALDatasetGetLayerCount : fn (HDataset) -> i32;
    gdal_get_layer = GDALDatasetGetLayer : fn (HDataset, i32) -> HLayer;
    gdal_get_layer_by_name = GDALDatasetGetLayerByName : fn (HDataset, *const u8) -> HLayer;

    ogr_l_get_feature_count = OGR_L_GetFeatureCount : fn (HLayer, i32) -> i32;
    ogr_l_get_name = OGR_L_GetName : fn (HLayer) -> *const u8;
    ogr_l_reset_reading = OGR_L_ResetReading : fn (HLayer) -> ();
    ogr_l_get_next_feature = OGR_L_GetNextFeature : fn (HLayer) -> HFeature;
    ogr_l_get_defn = OGR_L_GetLayerDefn : fn (HLayer) -> *mut c_void;
    ogr_l_get_spatial_ref = OGR_L_GetSpatialRef : fn (HLayer) -> HSRS;

    ogr_fd_get_field_count = OGR_FD_GetFieldCount : fn (*mut c_void) -> i32;
    ogr_fd_get_field_defn = OGR_FD_GetFieldDefn : fn (*mut c_void, i32) -> *mut c_void;
    ogr_fld_get_name = OGR_Fld_GetNameRef : fn (*mut c_void) -> *const u8;
    ogr_fld_get_type = OGR_Fld_GetType : fn (*mut c_void) -> i32;

    ogr_f_destroy = OGR_F_Destroy : fn (HFeature) -> ();
    ogr_f_get_field_index = OGR_F_GetFieldIndex : fn (HFeature, *const u8) -> i32;
    ogr_f_get_field_as_string = OGR_F_GetFieldAsString : fn (HFeature, i32) -> *const u8;
    ogr_f_get_geometry_ref = OGR_F_GetGeometryRef : fn (HFeature) -> HGeom;

    ogr_g_clone = OGR_G_Clone : fn (HGeom) -> HGeom;
    ogr_g_destroy = OGR_G_DestroyGeometry : fn (HGeom) -> ();
    ogr_g_get_geometry_count = OGR_G_GetGeometryCount : fn (HGeom) -> i32;
    ogr_g_get_geometry_ref = OGR_G_GetGeometryRef : fn (HGeom, i32) -> HGeom;
    ogr_g_get_point_count = OGR_G_GetPointCount : fn (HGeom) -> i32;
    ogr_g_get_x = OGR_G_GetX : fn (HGeom, i32) -> f64;
    ogr_g_get_y = OGR_G_GetY : fn (HGeom, i32) -> f64;
    ogr_g_get_envelope = OGR_G_GetEnvelope : fn (HGeom, *mut Envelope) -> i32;
    ogr_g_contains = OGR_G_Contains : fn (HGeom, HGeom) -> i32;
    ogr_g_distance = OGR_G_Distance : fn (HGeom, HGeom) -> f64;
    ogr_g_create_geometry = OGR_G_CreateGeometry : fn (u32) -> HGeom;
    ogr_g_add_point_2d = OGR_G_AddPoint_2D : fn (HGeom, f64, f64) -> ();
    ogr_g_length = OGR_G_Length : fn (HGeom) -> f64;
    ogr_g_flatten_to2d = OGR_G_FlattenTo2D : fn (HGeom) -> i32;

    osr_new_srs = OSRNewSpatialReference : fn (*const u8) -> HSRS;
    osr_destroy_srs = OSRDestroySpatialReference : fn (HSRS) -> ();
    osr_import_from_epsg = OSRImportFromEPSG : fn (HSRS, i32) -> i32;
    osr_set_axis_mapping = OSRSetAxisMappingStrategy : fn (HSRS, i32) -> i32;
    osr_authority_code = OSRGetAuthorityCode : fn (HSRS, *const u8) -> *const u8;
    osr_auto_identify_epsg = OSRAutoIdentifyEPSG : fn (HSRS) -> i32;
    osr_set_from_user_input = OSRSetFromUserInput : fn (HSRS, *const u8) -> i32;
    osr_export_wkt = OSRExportToWkt : fn (HSRS, *mut *mut u8) -> i32;
    oct_new_ct = OCTNewCoordinateTransformation : fn (HSRS, HSRS) -> HCT;
    oct_destroy_ct = OCTDestroyCoordinateTransformation : fn (HCT) -> ();
    oct_transform = OCTTransform : fn (HCT, i32, *mut f64, *mut f64, *mut f64) -> i32;

    gdal_get_raster_xsize = GDALGetRasterXSize : fn (HDataset) -> i32;
    gdal_get_raster_ysize = GDALGetRasterYSize : fn (HDataset) -> i32;
    gdal_get_geo_transform = GDALGetGeoTransform : fn (HDataset, *mut f64) -> i32;
    gdal_get_raster_count = GDALGetRasterCount : fn (HDataset) -> i32;
    gdal_get_raster_band = GDALGetRasterBand : fn (HDataset, i32) -> HBand;
    gdal_get_nodata = GDALGetRasterNoDataValue : fn (HBand, *mut i32) -> f64;
    gdal_raster_io = GDALRasterIO : fn (HBand, i32, i32, i32, i32, i32, *mut c_void, i32, i32, u32, i32, i32) -> i32;
    gdal_get_projection_ref = GDALGetProjectionRef : fn (HDataset) -> *const u8;
    gdal_get_statistics = GDALGetRasterStatistics : fn (HBand, i32, i32, *mut f64, *mut f64, *mut f64, *mut f64) -> i32;
}

pub struct Gdal {
    _libs: Vec<&'static Library>,
    pub f: &'static Fns,
}

unsafe impl Send for Gdal {}
unsafe impl Sync for Gdal {}

static GDAL: OnceLock<Result<&'static Gdal, String>> = OnceLock::new();

/// 初始化：dir = 含 gdal*.dll 的目录（如 rasterio.libs）；自动预载同目录依赖并定位 GDAL_DATA/PROJ。
pub fn init(dir: &str) -> Result<&'static Gdal, String> {
    GDAL.get_or_init(|| init_inner(dir)).clone()
}

pub fn get() -> Result<&'static Gdal, String> {
    GDAL.get()
        .ok_or_else(|| "GDAL 未初始化，请先在设置中指定 GDAL DLL 目录".to_string())?
        .clone()
}

fn init_inner(dir: &str) -> Result<&'static Gdal, String> {
    let dir_path = PathBuf::from(dir);
    if !dir_path.is_dir() {
        return Err(format!("目录不存在: {}", dir));
    }
    // 数据目录探测与 PROJ/GDAL 环境变量必须在加载 DLL 之前设置
    // （DLL 的 CRT 在加载时快照进程环境；rasterio 布局为同级 rasterio/{gdal_data,proj_data}）
    let parent = dir_path.parent().map(Path::to_path_buf);
    let gdal_data = dir_path
        .join("gdal_data")
        .is_dir()
        .then(|| dir_path.join("gdal_data"))   // 便携布局：DLL 目录自带数据
        .or_else(|| parent.as_deref().map(|p| p.join("rasterio").join("gdal_data")).filter(|p| p.is_dir()))
        .or_else(|| parent.as_deref().map(|p| p.join("osgeo").join("data").join("gdal")).filter(|p| p.is_dir()));
    let proj_data = dir_path
        .join("proj_data")
        .is_dir()
        .then(|| dir_path.join("proj_data"))   // 便携布局
        .or_else(|| parent.as_deref().map(|p| p.join("rasterio").join("proj_data")).filter(|p| p.is_dir()))
        .or_else(|| parent.as_deref().map(|p| p.join("osgeo").join("data").join("proj")).filter(|p| p.is_dir()));
    unsafe {
        if let Some(d) = &gdal_data {
            set_env_c("GDAL_DATA", &d.to_string_lossy());
        }
        if let Some(d) = &proj_data {
            set_env_c("PROJ_LIB", &d.to_string_lossy());
            set_env_c("PROJ_DATA", &d.to_string_lossy());
        }
    }
    // 定位 gdal 主库；用 ALTERED_SEARCH_PATH 使其从自身目录解析全部依赖
    let mut entries: Vec<PathBuf> = std::fs::read_dir(&dir_path)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|d| d.path()))
        .filter(|p| p.extension().map(|x| x.eq_ignore_ascii_case("dll")).unwrap_or(false))
        .collect();
    entries.sort();
    let gdal_candidates: Vec<PathBuf> = entries
        .iter()
        .filter(|p| {
            p.file_stem()
                .map(|s| s.to_string_lossy().to_lowercase().starts_with("gdal"))
                .unwrap_or(false)
        })
        .cloned()
        .collect();
    if gdal_candidates.is_empty() {
        return Err(format!("目录中未找到 gdal*.dll: {}", dir));
    }
    let gdal_path = &gdal_candidates[0];
    #[cfg(windows)]
    let gdal_lib: &'static Library = Box::leak(Box::new(
        unsafe {
            use libloading::os::windows::{Library as WLibrary, LOAD_WITH_ALTERED_SEARCH_PATH};
            let lib = WLibrary::load_with_flags(gdal_path, LOAD_WITH_ALTERED_SEARCH_PATH)
                .map_err(|e| format!("加载 {:?} 失败: {}", gdal_path, e))?;
            Library::from(lib)
        },
    ));
    #[cfg(not(windows))]
    let gdal_lib: &'static Library = Box::leak(Box::new(
        unsafe { Library::new(gdal_path) }.map_err(|e| format!("加载 {:?} 失败: {}", gdal_path, e))?,
    ));
    let loaded: Vec<&'static Library> = vec![gdal_lib];
    let fns: &'static Fns = Box::leak(Box::new(load_all(gdal_lib)?));

    unsafe {
        if let Some(d) = &gdal_data {
            let key = b"GDAL_DATA\0";
            let mut val = d.to_string_lossy().into_owned().into_bytes();
            val.push(0);
            (fns.cpl_set_config)(key.as_ptr(), val.as_ptr());
        }
        (fns.gdal_all_register)();
    }
    let g = Gdal { _libs: loaded, f: fns };
    Ok(Box::leak(Box::new(g)))
}

impl Gdal {
    pub fn version(&self) -> String {
        unsafe {
            let p = (self.f.gdal_version_info)(b"--version\0".as_ptr());
            cstr_to_string(p)
        }
    }

    pub fn last_error(&self) -> String {
        unsafe { cstr_to_string((self.f.cpl_get_last_err_msg)()) }
    }
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn SetEnvironmentVariableW(name: *const u16, value: *const u16) -> i32;
}

/// 同时写 Win32 进程环境块、UCRT 环境与 Rust 环境
/// （DLL 内 C 库经自身 CRT getenv 读取，仅 SetEnvironmentVariableW 不够）
#[cfg(windows)]
unsafe fn set_env_c(name: &str, value: &str) {
    use std::os::windows::ffi::OsStrExt;
    let wn: Vec<u16> = std::ffi::OsStr::new(name).encode_wide().chain(std::iter::once(0)).collect();
    let wv: Vec<u16> = std::ffi::OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect();
    SetEnvironmentVariableW(wn.as_ptr(), wv.as_ptr());
    if let Ok(ucrt) = Library::new("ucrtbase.dll") {
        if let Ok(f) = ucrt.get::<unsafe extern "C" fn(*const u16, *const u16) -> i32>(b"_wputenv_s ") {
            (f)(wn.as_ptr(), wv.as_ptr());
        }
    }
    std::env::set_var(name, value);
}

#[cfg(not(windows))]
unsafe fn set_env_c(name: &str, value: &str) {
    std::env::set_var(name, value);
}

pub fn cstr_to_string(p: *const u8) -> String {
    if p.is_null() {
        return String::new();
    }
    unsafe {
        let mut len = 0usize;
        while *p.add(len) != 0 {
            len += 1;
        }
        String::from_utf8_lossy(std::slice::from_raw_parts(p, len)).into_owned()
    }
}

/// 从 WKT 提取 EPSG 代码（取最后一个 EPSG AUTHORITY）
pub fn epsg_from_wkt(wkt: &str) -> Option<i32> {
    let mut code: Option<i32> = None;
    let mut rest = wkt;
    while let Some(pos) = rest.find("EPSG\"") {
        let after = &rest[pos + 5..];
        if let Some(q) = after.find('"') {
            if let Ok(v) = after[..q].parse::<i32>() {
                code = Some(v);
            }
        }
        rest = after;
    }
    code
}
