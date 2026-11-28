//! 内置土种编码表与色带表（编译期嵌入），以及颜色/编号查询。
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::OnceLock;

pub static CODES_JSON: &str = include_str!("../resources/soil_codes.json");
pub static COLORS_JSON: &str = include_str!("../resources/soil_colors.json");

pub struct Builtin {
    /// 土种名 -> 编号
    pub code_by_tz: HashMap<String, String>,
    /// 任意层级名称 -> 颜色
    pub color_by_name: HashMap<String, String>,
    /// 土类名列表（供下拉）
    pub tl_names: Vec<String>,
    /// 土种全表（前端展示）
    pub codes: Value,
    pub colors: Value,
}

static BUILTIN: OnceLock<Builtin> = OnceLock::new();

/// 由外部 JSON 构建（用户导入覆盖用）；格式与内置表一致：
/// codes: [{code,tz,ts,yl,tl}]，colors: [{name,hex,level}]
pub fn build(codes: Value, colors: Value) -> Builtin {
    let mut b = Builtin { code_by_tz: HashMap::new(), color_by_name: HashMap::new(), tl_names: Vec::new(), codes, colors };
    if let Some(arr) = b.codes.as_array() {
        for it in arr {
            if let (Some(tz), Some(cd)) = (
                it.get("tz").and_then(|v| v.as_str()),
                it.get("code").and_then(|v| v.as_str()),
            ) {
                if !tz.is_empty() { b.code_by_tz.insert(tz.to_string(), cd.to_string()); }
            }
        }
    }
    if let Some(arr) = b.colors.as_array() {
        for it in arr {
            if let (Some(nm), Some(hx)) = (
                it.get("name").and_then(|v| v.as_str()),
                it.get("hex").and_then(|v| v.as_str()),
            ) {
                if it.get("level").and_then(|v| v.as_str()) == Some("土类") {
                    b.tl_names.push(nm.to_string());
                }
                b.color_by_name.insert(nm.to_string(), hx.to_string());
            }
        }
    }
    b
}

pub fn get() -> &'static Builtin {
    BUILTIN.get_or_init(|| {
        let codes: Value = serde_json::from_str(CODES_JSON).unwrap_or_else(|_| json!([]));
        let colors: Value = serde_json::from_str(COLORS_JSON).unwrap_or_else(|_| json!([]));
        build(codes, colors)
    })
}

/// 土种名 -> 编号（找不到返回 None）
pub fn code_of(tz: &str) -> Option<String> {
    get().code_by_tz.get(tz).cloned()
}

/// 按 土种->土属->亚类->土类 逐级匹配颜色
pub fn color_of(tz: &str, ts: &str, yl: &str, tl: &str) -> String {
    let b = get();
    for nm in [tz, ts, yl, tl] {
        if !nm.is_empty() {
            if let Some(c) = b.color_by_name.get(nm) {
                return c.clone();
            }
        }
    }
    "#cccccc".to_string()
}

/// 覆盖表查询（AppState 持有用户导入表时优先）
impl Builtin {
    pub fn code_of_ov(&self, tz: &str) -> Option<String> {
        self.code_by_tz.get(tz).cloned()
    }
    pub fn color_of_ov(&self, tz: &str, ts: &str, yl: &str, tl: &str) -> String {
        for nm in [tz, ts, yl, tl] {
            if !nm.is_empty() {
                if let Some(c) = self.color_by_name.get(nm) {
                    return c.clone();
                }
            }
        }
        "#cccccc".to_string()
    }
}

/* ---------------- 区县编码/配色方案（基于配色推荐标准） ---------------- */
pub static HUE_PRESETS_JSON: &str = include_str!("../resources/hue_presets.json");
pub static HUE_RAMPS_JSON: &str = include_str!("../resources/hue_ramps.json");

fn hex_rgb(h: &str) -> (u8, u8, u8) {
    let h = h.trim_start_matches('#');
    if h.len() != 6 { return (204, 204, 204); }
    (u8::from_str_radix(&h[0..2], 16).unwrap_or(204), u8::from_str_radix(&h[2..4], 16).unwrap_or(204), u8::from_str_radix(&h[4..6], 16).unwrap_or(204))
}
fn rgb_hex(r: u8, g: u8, b: u8) -> String {
    format!("#{:02x}{:02x}{:02x}", r, g, b)
}

/// 土类推荐色调的色标梯度中取第 i/n 档（n 份，i∈[0,n)，0=最淡，n-1=最浓）；
/// 档数超过色标级数时在相邻级间线性插值（与原配色工具一致）
pub fn ramp_color(tl: &str, idx: usize, n: usize) -> Option<String> {
    if n == 0 { return None; }
    let presets: Vec<Value> = serde_json::from_str(HUE_PRESETS_JSON).unwrap_or_default();
    let ramps: std::collections::HashMap<String, Vec<String>> =
        serde_json::from_str(HUE_RAMPS_JSON).unwrap_or_default();
    let p = presets.iter().find(|p| p.get("tl").and_then(|v| v.as_str()) == Some(tl))?;
    let series = p.get("series").and_then(|v| v.as_str()).unwrap_or("");
    let tone = p.get("tone").and_then(|v| v.as_str()).unwrap_or("");
    if series.is_empty() || tone.is_empty() { return None; }
    let key = format!("{}/{}", series, tone);
    let ramp = ramps.get(&key)?;
    if ramp.is_empty() { return None; }
    if n == 1 { return Some(format!("#{}", ramp[ramp.len() / 2])); }
    let t = idx as f64 / (n - 1) as f64 * (ramp.len() - 1) as f64;
    let lo = t.floor() as usize;
    let hi = (lo + 1).min(ramp.len() - 1);
    let f = t - lo as f64;
    let (r1, g1, b1) = hex_rgb(&ramp[lo]);
    let (r2, g2, b2) = hex_rgb(&ramp[hi]);
    Some(rgb_hex(
        (r1 as f64 + (r2 as f64 - r1 as f64) * f).round() as u8,
        (g1 as f64 + (g2 as f64 - g1 as f64) * f).round() as u8,
        (b1 as f64 + (b2 as f64 - b1 as f64) * f).round() as u8,
    ))
}
