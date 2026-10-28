// Jev selects source text; it never invents a field value. Explicit --text values take precedence.
const QUOTED = /[“"'「『『《]([^”"'」』』》]{1,60})[”"'」』』》]/gu;
// A value the goal asks for without quoting it: `输入重庆、选择…`. The verb marks where the value
// starts and the next clause mark ends it. Chinese is written without spaces, so the span search below
// can only offer the whole sentence, and the model answers NONE instead of typing it.
const ASKED =
  /(?:输入|搜索|查找|查询|填写|键入|录入|enter|type|search for|search|input)\s*([^\s。；;，,、：:]{2,40})/giu;

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
  for (const match of goal.matchAll(ASKED)) {
    const value = match[1].trim();
    // Only for text written without spaces: an English value keeps its spaces, and the span search
    // below already offers it whole.
    if (value && /\p{Script=Han}/u.test(value)) values.add(value);
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
