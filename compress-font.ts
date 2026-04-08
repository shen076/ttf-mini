/**
 * compress-font.ts
 *
 * 将 OTF/TTF 压缩为 WOFF2 子集，保留常用简/繁体中文 + ASCII + 标点符号。
 * 底层依赖 Python fonttools（首次运行时会尝试自动安装）。
 *
 * 用法:
 *   npx tsx compress-font.ts <字体文件>          # 完整简/繁体中文模式
 *   npx tsx compress-font.ts <字体文件> --gb2312  # 仅 GB2312 字符范围（简体为主）
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Unicode 区间定义
// ---------------------------------------------------------------------------

/**
 * 完整模式：覆盖绝大多数简体 + 繁体中文 + ASCII + 各类标点。
 * CJK 统一汉字主区 U+4E00-9FFF 含 ~20,902 个字，简/繁体绝大多数字均在其中。
 */
const RANGES_FULL: [string, string][] = [
  ["U+0020-007E", "ASCII 可打印字符"],
  ["U+00A0-00FF", "Latin-1 补充（带音调拉丁字母等）"],
  ["U+2000-206F", "通用标点（引号、破折号等）"],
  ["U+2E80-2EFF", "CJK 部首补充"],
  ["U+2F00-2FDF", "康熙部首"],
  ["U+3000-303F", "CJK 符号和标点（全角句号、书名号等）"],
  ["U+3100-312F", "注音符号（繁体拼音）"],
  ["U+31A0-31BF", "注音符号扩展"],
  ["U+4E00-9FFF", "CJK 统一汉字主区（简/繁体均覆盖）"],
  ["U+F900-FAFF", "CJK 兼容汉字"],
  ["U+FE10-FE1F", "竖排变体标点"],
  ["U+FE30-FE4F", "CJK 兼容形式"],
  ["U+FE50-FE6F", "小形式变体"],
  ["U+FF00-FFEF", "全角/半角形式"],
];

/**
 * GB2312 精简模式：GB2312 主范围内的 CJK 字符，
 * 不含部分扩展繁体字及现代新字。
 */
const RANGES_GB2312: [string, string][] = [
  ["U+0020-007E", "ASCII 可打印字符"],
  ["U+00A0-00FF", "Latin-1 补充"],
  ["U+2000-206F", "通用标点"],
  ["U+3000-303F", "CJK 符号和标点"],
  ["U+4E00-9FA5", "GB2312 CJK 范围"],
  ["U+FE30-FE4F", "CJK 兼容形式"],
  ["U+FF00-FFEF", "全角/半角形式"],
];

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function fmt(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function findPyftsubset(): string | null {
  // 1. 优先检查 PATH（fonttools --help 返回 exit 2，需特殊处理）
  try {
    execSync("pyftsubset --help", { stdio: "pipe" });
    return "pyftsubset";
  } catch (e: any) {
    const out = (e?.stdout?.toString() ?? "") + (e?.stderr?.toString() ?? "");
    if (out.includes("fonttools") || out.includes("subset")) {
      return "pyftsubset";
    }
  }
  // 2. pyenv shim 路径兜底
  const shimPath = `${process.env.HOME}/.pyenv/shims/pyftsubset`;
  if (existsSync(shimPath)) return shimPath;
  return null;
}

function ensureFonttools(): void {
  if (findPyftsubset()) {
    console.log("✔ pyftsubset 已就绪");
    return;
  }
  console.log("→ 未检测到 pyftsubset，尝试安装 fonttools + brotli …");
  try {
    execSync("pip3 install fonttools brotli", { stdio: "inherit" });
  } catch {
    execSync("pip install fonttools brotli", { stdio: "inherit" });
  }
  if (!findPyftsubset()) {
    throw new Error(
      "fonttools 安装失败，请手动运行: pip3 install fonttools brotli",
    );
  }
  console.log("✔ 安装完成");
}

function runSubset(
  inputPath: string,
  outputPath: string,
  ranges: [string, string][],
): void {
  const bin = findPyftsubset()!;
  const unicodes = ranges.map(([r]) => r).join(",");

  const args = [
    `"${inputPath}"`,
    `--unicodes="${unicodes}"`,
    "--layout-features=*", // 保留所有 OpenType 特性（kern、liga 等）
    "--glyph-names",
    "--symbol-cmap",
    "--legacy-cmap",
    "--notdef-glyph",
    "--notdef-outline",
    "--recommended-glyphs",
    "--name-IDs=*",
    "--no-hinting", // 去掉 hinting（网页字体无需，减小体积）
    "--desubroutinize", // 展开 CFF subroutine，有利于 WOFF2 再压缩
    "--drop-tables+=SVG", // 丢弃 SVG 彩色表（文本字体用不到）
    "--flavor=woff2",
    `--output-file="${outputPath}"`,
  ].join(" ");

  execSync(`"${bin}" ${args}`, { stdio: "inherit" });
}

function writeCss(
  fontName: string,
  woff2File: string,
  dir: string,
  suffix: string,
): void {
  const cssPath = path.join(dir, `${fontName}${suffix}.css`);
  const css = `/* 自动生成的 @font-face 声明 */
@font-face {
  font-family: '${fontName}';
  src: url('./${woff2File}') format('woff2');
  font-weight: normal;
  font-style: normal;
  font-display: swap; /* 先用系统字体显示，加载完成后平滑切换 */
}
`;
  writeFileSync(cssPath, css, "utf8");
  console.log(`→ CSS: ${path.basename(cssPath)}`);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main(): void {
  const argv = process.argv.slice(2);
  const gb2312Mode = argv.includes("--gb2312");
  const inputFile = argv.find((a) => !a.startsWith("--"));

  if (!inputFile) {
    console.error(
      "用法: npx tsx compress-font.ts <字体文件.otf> [--gb2312]\n" +
        "  --gb2312   使用 GB2312 字符范围（简体为主，不含部分扩展繁体字）",
    );
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  if (!existsSync(inputPath)) {
    console.error(`文件不存在: ${inputPath}`);
    process.exit(1);
  }

  ensureFonttools();

  const ext = path.extname(inputPath);
  const base = path.basename(inputPath, ext);
  // 输出到脚本运行目录下的 font/ 文件夹
  const dir = path.resolve("font");
  mkdirSync(dir, { recursive: true });
  const suffix = gb2312Mode ? "-gb2312-subset" : "-subset";
  const outputPath = path.join(dir, `${base}${suffix}.woff2`);

  const originalSize = statSync(inputPath).size;
  const ranges = gb2312Mode ? RANGES_GB2312 : RANGES_FULL;

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`输入文件 : ${path.basename(inputPath)}  (${fmt(originalSize)})`);
  console.log(
    `压缩模式 : ${gb2312Mode ? "GB2312 精简（简体为主）" : "完整简/繁体中文"}`,
  );
  console.log("Unicode 区间:");
  ranges.forEach(([range, desc]) =>
    console.log(`  ${range.padEnd(18)} ${desc}`),
  );
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  console.log("→ 开始子集化（可能需要 1-2 分钟，字体较大请耐心等待）…\n");

  runSubset(inputPath, outputPath, ranges);

  const outputSize = statSync(outputPath).size;
  const reduction = ((1 - outputSize / originalSize) * 100).toFixed(1);

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`输出文件 : ${path.basename(outputPath)}`);
  console.log(
    `大小     : ${fmt(originalSize)}  →  ${fmt(outputSize)}  (缩减 ${reduction}%)`,
  );

  writeCss(base, path.basename(outputPath), dir, suffix);

  console.log(
    `\n在 HTML <head> 中引用：\n  <link rel="stylesheet" href="${base}${suffix}.css">`,
  );
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}

main();
