// Jev selects source text; it never invents a field value. Explicit --text values take precedence.
const QUOTED = /[“"'「『『《]([^”"'」』』》]{1,60})[”"'」』』》]/gu;

export function textCandidates(goal, supplied = []) {
  if (supplied.length)
    return { values: [...new Set(supplied)], source: 'supplied', overflow: false };
  const values = new Set();
  // A quoted span is the value the goal is asking for, and it is the only dependable signal in a
  // language written without spaces: `在搜索框输入“充电站”` has one whitespace-delimited word, so the
  // span search below would offer the whole sentence and nothing else.
  for (const match of goal.matchAll(QUOTED)) {
    const value = match[1].trim();
    if (value) values.add(value);
  }
  const words = [...goal.matchAll(/\S+/gu)];
  for (let length = 1; length <= Math.min(8, words.length); length++) {
    for (let start = 0; start + length <= words.length; start++) {
      const end = words[start + length - 1];
      const value = goal
        .slice(words[start].index, end.index + end[0].length)
        .replace(/^["'“‘([{]+|["'”’)\]},.!?;:]+$/gu, '')
        .trim();
      if (value) values.add(value);
      if (values.size > 254) return { values: [], source: 'goal', overflow: true };
    }
  }
  return { values: [...values], source: 'goal', overflow: false };
}
