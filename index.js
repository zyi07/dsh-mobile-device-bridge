/**
 * Host half of dsh-mobile-bridge.
 *
 * 本插件的实际能力全部在浏览器侧（WebUSB 只能由页面里的用户手势触发），
 * 因此 Host 半没有可注册的工具或服务，保持空实现。
 * 之前版本在这里注册的 mobile_shell / mobile_screenshot 只是返回
 * "请使用 UI" 的假工具，已删除。
 */
export function apply() {}