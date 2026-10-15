/**
 * 站点备案信息（页面底部居中展示，全站生效，改这里即可）
 * - ICP 备案（工信部）：https://beian.miit.gov.cn/
 * - 公安备案：https://beian.mps.gov.cn/ ，ICP 备案通过后 30 日内办理
 * 还没办好的那项，把 show 设为 false 即可（不会渲染出来）。
 */
export const SITE = {
  icp: {
    text: "苏ICP备2026068173号-2",
    link: "https://beian.miit.gov.cn/",
    show: true,
  },
  police: {
    text: "苏公网安备32120402001317号",
    link: "https://beian.mps.gov.cn/#/query/webSearch?code=32120402001317",
    // 公安备案图标，文件在 public/beian-icon.png
    icon: "/beian-icon.png",
    show: true,
  },
};

export const LINKS = {
  github: "https://github.com/zhiaifree",
  discord: "https://discordapp.com/users/163300027618295808",
  bilibili: "https://space.bilibili.com/133469375",
  email: "zhenkai.yang@qq.com",
};

export const loaderAnimation = [
  ".loader",
  { opacity: [1, 0], pointerEvents: "none" },
  { easing: "ease-out" },
];
