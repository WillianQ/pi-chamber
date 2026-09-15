// 模糊匹配（子序列 + 打分排序）——原样搬自 @earendil-works/pi-tui@0.84.4 dist/fuzzy.js。
// 逻辑一行未改（只删了 sourceMappingURL），要改先看一眼 pi 的同名文件：
//   · fuzzyMatch(query, text)：query 的字符在 text 里按序出现即命中，返回 { matches, score }（分越小越好）。
//     连续命中 −5/个、词边界（空格 - _ . / : 之后）−10、越靠后 +0.1×i、全等 −100；
//     纯「字母+数字」的 query 失败后会把两段对调再试一次（打 3.8qwen 也能找到 qwen3.8-flash），代价 +5。
//   · fuzzyFilter(items, query, getText)：query 按空白与 / 切词，**全部命中**才算，按总分升序。
//     getText 由调用方给（本仓命令节点是 { value, description?, options? }，见 pages/chat/command-match.js）。
export function fuzzyMatch(query, text) {
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();

  const matchQuery = (normalizedQuery) => {
    if (normalizedQuery.length === 0) return { matches: true, score: 0 };
    if (normalizedQuery.length > textLower.length) return { matches: false, score: 0 };

    let queryIndex = 0;
    let score = 0;
    let lastMatchIndex = -1;
    let consecutiveMatches = 0;

    for (let i = 0; i < textLower.length && queryIndex < normalizedQuery.length; i++) {
      if (textLower[i] === normalizedQuery[queryIndex]) {
        const isWordBoundary = i === 0 || /[\s\-_./:]/.test(textLower[i - 1]);

        // Reward consecutive matches
        if (lastMatchIndex === i - 1) {
          consecutiveMatches++;
          score -= consecutiveMatches * 5;
        } else {
          consecutiveMatches = 0;
          // Penalize gaps
          if (lastMatchIndex >= 0) score += (i - lastMatchIndex - 1) * 2;
        }
        // Reward word boundary matches
        if (isWordBoundary) score -= 10;
        // Slight penalty for later matches
        score += i * 0.1;

        lastMatchIndex = i;
        queryIndex++;
      }
    }

    if (queryIndex < normalizedQuery.length) return { matches: false, score: 0 };
    if (normalizedQuery === textLower) score -= 100;

    return { matches: true, score };
  };

  const primaryMatch = matchQuery(queryLower);
  if (primaryMatch.matches) return primaryMatch;

  // Egg: letters+digits swapped once (qwen3.8 ↔ 38qwen)
  const alphaNumericMatch = queryLower.match(/^(?<letters>[a-z]+)(?<digits>[0-9]+)$/);
  const numericAlphaMatch = queryLower.match(/^(?<digits>[0-9]+)(?<letters>[a-z]+)$/);
  const swappedQuery = alphaNumericMatch
    ? `${alphaNumericMatch.groups?.digits ?? ""}${alphaNumericMatch.groups?.letters ?? ""}`
    : numericAlphaMatch
      ? `${numericAlphaMatch.groups?.letters ?? ""}${numericAlphaMatch.groups?.digits ?? ""}`
      : "";

  if (!swappedQuery) return primaryMatch;

  const swappedMatch = matchQuery(swappedQuery);
  if (!swappedMatch.matches) return primaryMatch;

  return { matches: true, score: swappedMatch.score + 5 };
}

/** Filter and sort items by fuzzy match quality (best matches first).
 *  query 按空白与 / 切词，所有词都命中才保留；空 query 原样返回。 */
export function fuzzyFilter(items, query, getText) {
  if (!query.trim()) return items;

  const tokens = query
    .trim()
    .split(/[\s/]+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return items;

  const results = [];
  for (const item of items) {
    const text = getText(item);
    let totalScore = 0;
    let allMatch = true;
    for (const token of tokens) {
      const match = fuzzyMatch(token, text);
      if (match.matches) totalScore += match.score;
      else {
        allMatch = false;
        break;
      }
    }
    if (allMatch) results.push({ item, totalScore });
  }

  results.sort((a, b) => a.totalScore - b.totalScore);
  return results.map((r) => r.item);
}
