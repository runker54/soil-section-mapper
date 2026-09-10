# 项目记忆 —— 土壤断面制图工具

## 构建与打包流程（Manba 指定，后续按此执行）

### 1. 代码结构
- 前端：`dist/`（app.js 纯 JS + index.html + style.css），**修改后必须重新 cargo build 才会嵌入 exe**（frontendDist 编译期打包）
- 后端：`src-tauri/src/`（commands.rs / pipeline.rs / gdal_ffi.rs / builtin.rs）
- 内置资源：`src-tauri/resources/*.json` 经 `include_str!` 编译进 exe（改 resources 也需重编）
- GDAL：动态加载 `app_gdal_env/Lib/site-packages/rasterio.libs`（开发），便携版用 exe 同级 `gdal/` 目录（gdal*.dll + gdal_data/ + proj_data/）

### 2. 构建（完整命令）
```bash
taskkill //IM soil-section-studio.exe //F 2>/dev/null   # exe 被占用会构建失败(os error 5)
cd soil-section-studio/src-tauri && cargo build --release
```
- 前端改动同样走上面命令（无前端构建步骤）
- 编译要求零警告（死代码/未用导入一律清理）

### 3. 全量测试（构建后必跑）
- 后端：`cargo run --release --bin fulltest` → 必须 20/20 PASS
- UI 全量：启动真实程序（带 CDP），用分步验证脚本覆盖各模块
```bash
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" ./target/release/soil-section-studio.exe &
# CDP 脚本：原生 WebSocket + Runtime.evaluate；拖动验证必须用 Input.dispatchMouseEvent 真实鼠标序列
#（禁止用合成 DragEvent——Tauri 拦截原生 drag 会话，合成事件会给出虚假通过）
```
- 测试数据：4326 坐标测试线/点必须造在 DEM 范围内（约 105.3E, 25.1N），否则高程采样为 0

### 4. 便携版打包
```python
# 结构：土壤断面制图工具/{土壤断面制图工具.exe, gdal/{*.dll, gdal_data/, proj_data/}, 使用说明.txt}
# exe 拷自 target/release/soil-section-studio.exe（重命名）
# gdal 内容拷自 app_gdal_env/Lib/site-packages/rasterio.libs(全部dll) + rasterio/{gdal_data,proj_data}
# zip 用 python zipfile（UTF-8 flag），排除 temp/ 运行缓存；打包后用 Expand-Archive 验证中文文件名
```
- 产物：`土壤断面制图工具-便携版.zip`（约 26MB）
- 程序零 Python 运行时依赖（历史 py 为原型脚本，功能已移植 Rust；如需源码保护另做 JS 混淆，Manba 会另行通知）

### 5. 关键约定
- 窗口 title / productName：`土壤断面制图工具 SoilSection Mapper`
- 图层列表顶 = 地图顶层（QGIS 惯例）；新图层插入列表顶部
- 拖动排序：纯指针实现（mousedown/mousemove/mouseup），禁用 HTML5 draggable（Tauri dragDropEnabled=false）
- 识别为显式模式（mapmode=identify 才弹图斑属性）
- DEM/土壤图装载后才出现在图层列表；空剖面不占图层项
