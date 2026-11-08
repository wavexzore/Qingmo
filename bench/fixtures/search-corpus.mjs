import fs from "node:fs";
import path from "node:path";

/**
 * Deterministic Markdown corpus for the local-search benchmark.
 *
 * Every file mixes a unique Latin token, CJK 1–2 character terms and a 3+
 * character CJK phrase so all FTS routing paths are exercised.
 */
export function generateSearchCorpus({ root, count, targetBytes = 2048 }) {
  fs.mkdirSync(root, { recursive: true });
  const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
  for (let index = 0; index < count; index += 1) {
    const word = words[index % words.length];
    const header = `# 文档 ${index} — ${word} ${index}\n\n`;
    const chunk = [
      `主题 ${word}，中文标题与正文用于检索。`,
      `English paragraph ${index} with hello world and searchable text.`,
      `中文关键词：中文标、数据安全、本地检索、版本历史。`,
      `Unique token t${index} keeps each document distinguishable.`,
      "",
    ].join("\n");
    let body = header;
    while (Buffer.byteLength(body, "utf8") < targetBytes) {
      body += chunk;
    }
    const directory = path.join(root, `bucket-${String(index % 100).padStart(3, "0")}`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `doc-${String(index).padStart(6, "0")}.md`), body);
  }
  return { root, count, targetBytes };
}

export function corpusSize(root) {
  let files = 0;
  let bytes = 0;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile()) {
        files += 1;
        bytes += fs.statSync(full).size;
      }
    }
  };
  visit(root);
  return { files, bytes };
}
