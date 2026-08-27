/**
 * 关于模块静态配置（一次性编辑，集中管理）
 *
 * 链接类字段（website / github / gitee / feedback）留空则不渲染对应按钮。
 * 部署到自己的仓库后，把下面 TODO 占位换成真实地址即可。
 */
export interface AboutLink {
  key: 'website' | 'github' | 'gitee' | 'feedback'
  label: string
  icon: 'home' | 'external' | 'info'
  url: string
}

export interface TechItem {
  name: string
  detail: string
  url?: string
}

export interface ThirdPartyItem {
  name: string
  license: string
  url: string
}

export const ABOUT = {
  /** 应用名（与 package.json productName 一致） */
  name: '影匣',
  /** 一句话标语 */
  tagline: '本地影片海报墙管理 · 基于简介 md 的私人影库',
  /** 较长描述 */
  description:
    '影匣是一款面向本地影片收藏的桌面管理工具：选择视频文件夹 + 简介 md 文件，即可生成可按分类浏览的海报墙。' +
    '简介 md 为唯一权威来源（分类 / 简介 / 标签 / 评分），支持 JavDB 封面与详情抓取并本地永久缓存、四种皮肤、' +
    '虚拟滚动大库流畅、隐私护盾一键模糊预览图，以及按演员 / 片商 / 系列筛选与统计看板。',
  /** 作者 / 团队 */
  author: '影匣',
  /** 版权起始年份 */
  year: 2026,
  /** 许可证 */
  license: 'MIT',
  licenseUrl: 'https://opensource.org/licenses/MIT',

  /** 开源仓库地址（About 弹窗用于引导点亮 Star） */
  github: 'https://github.com/awei10/yingxia-video-manager',

  /** 外部链接（留空不渲染） */
  links: [
    {
      key: 'github',
      label: 'GitHub',
      icon: 'external',
      url: 'https://github.com/awei10/yingxia-video-manager'
    },
    {
      key: 'gitee',
      label: 'Gitee',
      icon: 'external',
      // TODO: 替换为你的真实仓库地址
      url: ''
    },
    {
      key: 'feedback',
      label: '反馈问题',
      icon: 'info',
      // TODO: 替换为 issue 页或邮箱（mailto:you@example.com）
      url: ''
    }
  ] as AboutLink[],

  /** 核心技术栈（自建部分） */
  techStack: [
    { name: 'Electron', detail: '跨平台桌面运行时', url: 'https://www.electronjs.org/' },
    { name: 'React', detail: 'UI 框架', url: 'https://react.dev/' },
    { name: 'TypeScript', detail: '开发语言', url: 'https://www.typescriptlang.org/' },
    { name: 'Vite', detail: '构建工具（electron-vite）', url: 'https://vitejs.dev/' },
    { name: 'Tailwind CSS', detail: '样式方案', url: 'https://tailwindcss.com/' }
  ] as TechItem[],

  /** 关键第三方依赖与数据来源（致谢） */
  thirdParty: [
    { name: 'undici', license: 'MIT', url: 'https://github.com/nodejs/undici' },
    { name: 'archiver', license: 'MIT', url: 'https://github.com/archiverjs/node-archiver' },
    { name: 'JavDB', license: '数据来源', url: 'https://javdb.com/' }
  ] as ThirdPartyItem[]
} as const
