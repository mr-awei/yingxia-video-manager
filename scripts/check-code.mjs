/**
 * 番号提取/归一化自检（P2-7 重建）。
 *
 * 用途：extractCode / extractBaseCode / normalizeCode / hasSeriesSuffix / isDomestic /
 *       normalizeManualCode 的规则多且互相牵制，改一处极易悄悄改坏另一处（历史教训：
 *       数字开头番号、FC2 前缀、伪番号守卫、画质前缀剥离都是后补的，互相影响）。
 *       每次改 src/shared/code.ts 前必跑本脚本，全绿才允许提交。
 *
 * 运行（零依赖，Node ≥ 22.6 用 --experimental-strip-types 直跑 TS）：
 *   node --experimental-strip-types scripts/check-code.mjs
 * 或：npm run check:code
 */
import {
  extractCode,
  extractBaseCode,
  normalizeCode,
  hasSeriesSuffix,
  isDomestic,
  normalizeManualCode
} from '../src/shared/code.ts'

let pass = 0
let fail = 0
const failures = []

/** eq(实际, 期望, 说明) */
function eq(actual, expected, label) {
  if (actual === expected) {
    pass++
  } else {
    fail++
    failures.push(`${label}\n    期望: ${JSON.stringify(expected)}\n    实际: ${JSON.stringify(actual)}`)
  }
}

// ============ 1. 标准番号（回归基线，绝不能改坏） ============
eq(extractCode('SONE-560'), 'SONE-560', '标准番号 SONE-560')
eq(extractCode('SSIS-419'), 'SSIS-419', '标准番号 SSIS-419')
eq(extractCode('sone-280.mp4'), 'SONE-280', '小写+扩展名 sone-280.mp4')
eq(extractCode('SONE_566'), 'SONE-566', '下划线分隔 SONE_566')
eq(extractCode('[SONE-560] 标题'), 'SONE-560', '方括号前缀')

// ============ 2. 数字开头番号（v2.3.12 新增，旧 6 步全漏） ============
eq(extractCode('261ARA-394'), '261ARA-394', '数字开头 261ARA-394')
eq(extractCode('476MLA-203'), '476MLA-203', '数字开头 476MLA-203')
eq(extractCode('259LUXU-1186'), '259LUXU-1186', '数字开头 259LUXU-1186')
eq(extractCode('200GANA-1459'), '200GANA-1459', '数字开头 200GANA-1459')
// 6 位时间戳（手机录像 V60803-173433）不能被误认番号
eq(extractCode('V60803-173433'), '', '手机录像时间戳 V60803-173433 应拒')

// ============ 3. FC2 番号（v2.3.12，旧逻辑丢 FC2- 前缀只留 PPV-xxx） ============
eq(extractCode('FC2-PPV-1510788'), 'FC2-PPV-1510788', 'FC2-PPV-1510788')
eq(extractCode('fc2ppv_1523314'), 'FC2-PPV-1523314', 'fc2ppv_1523314')
eq(extractCode('hhd800.com@FC2-PPV-1851398.mp4'), 'FC2-PPV-1851398', '域名前缀下仍取 FC2')
eq(extractCode('FC2-PPV-1851398_1'), 'FC2-PPV-1851398', 'FC2 分集尾号 _1 剥掉')

// ============ 4. 伪番号守卫（v2.3.12，命中即跳过继续找/返回空） ============
eq(extractCode('IMG_8873.MOV'), '', '相机文件 IMG_8873 应拒')
eq(extractCode('VID20160418123456.mp4'), '', '录像时间戳 VID2016… 应拒')
eq(extractCode('DSC_0001.JPG.mp4'), '', 'DSC 相机前缀应拒')

// ============ 5. 画质前缀剥离 ============
eq(extractCode('HD_sdnm-256'), 'SDNM-256', '画质前缀 HD_ 剥离')
eq(extractCode('hd_sdnm-256'), 'SDNM-256', '画质前缀小写 hd_ 剥离')

// ============ 6. normalizeCode 归一化（转大写 + 删除 空格/下划线/点，**保留连字符**） ============
eq(normalizeCode('sone-566'), 'SONE-566', 'normalizeCode 小写')
eq(normalizeCode('SONE-566'), 'SONE-566', 'normalizeCode 保留连字符')
eq(normalizeCode('SONE_566'), 'SONE566', 'normalizeCode 下划线删除')
eq(normalizeCode('sone.566'), 'SONE566', 'normalizeCode 点号删除')
eq(normalizeCode('SONE 566'), 'SONE566', 'normalizeCode 去空格')

// ============ 7. extractBaseCode / hasSeriesSuffix（系列分集） ============
eq(extractBaseCode('HUNTA-468CD2'), 'HUNTA-468', 'base HUNTA-468CD2')
eq(extractBaseCode('hunta-468-cd1'), 'HUNTA-468', 'base hunta-468-cd1')
eq(extractBaseCode('HUNTA-468-1'), 'HUNTA-468', 'base HUNTA-468-1')
eq(extractBaseCode('SONE-280'), 'SONE-280', 'SONE-280 不剥（正常序号）')
eq(extractBaseCode('SSIS-419'), 'SSIS-419', 'SSIS-419 不剥（正常序号）')
eq(hasSeriesSuffix('HUNTA-468A'), true, 'HUNTA-468A 是分集')
eq(hasSeriesSuffix('SONE-280'), false, 'SONE-280 非分集')

// ============ 8. normalizeManualCode（手工番号归一化，v2.3.12） ============
eq(normalizeManualCode('476MLA-203'), '476MLA-203', 'manual 476MLA-203')
eq(normalizeManualCode('476mla203'), '476MLA-203', 'manual 476mla203 补连字符')
eq(normalizeManualCode('SSIS376'), 'SSIS-376', 'manual SSIS376 补连字符')
eq(normalizeManualCode('476MLA-203.mp4'), '476MLA-203', 'manual 去扩展名')
eq(normalizeManualCode(''), '', 'manual 空串')
eq(normalizeManualCode('   '), '', 'manual 纯空白')

// ============ 9. isDomestic 国产判定 ============
eq(isDomestic('国产自拍精选', 'video.mp4'), true, '纯中文文件夹无番号 → 国产')
eq(isDomestic('SONE-560', 'SONE-560.mp4'), false, '无中文 → 非国产')
eq(isDomestic('我的番号', 'SONE-280.mp4'), false, '中文文件夹但文件带番号 → 非国产')

// ============ 10. 缓存确定性（P1-6：同一输入多次调用结果一致，含缓存的空串结果） ============
eq(extractCode('SONE-560'), extractCode('SONE-560'), '缓存：SONE-560 两次调用一致')
eq(extractCode('IMG_8873.MOV'), extractCode('IMG_8873.MOV'), '缓存：空串结果两次一致')
eq(normalizeCode('sone_566'), normalizeCode('sone_566'), '缓存：normalizeCode 两次一致')
eq(extractBaseCode('HUNTA-468CD2'), extractBaseCode('HUNTA-468CD2'), '缓存：extractBaseCode 两次一致')

// ============ 结果 ============
console.log(`\n[check-code] 通过 ${pass} / ${pass + fail}`)
if (fail > 0) {
  console.error(`\n[check-code] ${fail} 条断言失败：`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log('[check-code] 全部断言通过 ✓')
