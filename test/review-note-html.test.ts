import { describe, expect, it } from "vitest";
import {
  decodeEntities,
  REVIEW_NOTE_HTML_MAX_LENGTH,
  plainTextToReviewNoteHtml,
  reviewNotePlainText,
  sanitizeReviewNoteHtml,
  sanitizeReviewNoteValue,
} from "../src/lib/review-note-html";
import { validateReviewNote } from "../src/lib/review-schemes";

describe("sanitizeReviewNoteHtml whitelist", () => {
  it("keeps the Tiptap minimal subset verbatim", () => {
    const input =
      "<p>你好<strong>加粗</strong><em>斜体</em></p><blockquote><p>引用</p></blockquote><ul><li>一项</li></ul><ol><li>首项</li></ol>";
    expect(sanitizeReviewNoteHtml(input)).toBe(input);
  });

  it("drops script/style elements together with their content", () => {
    expect(
      sanitizeReviewNoteHtml(
        '<p>前</p><script>alert(1)</script><style>body{}</style><p>后</p>',
      ),
    ).toBe("<p>前</p><p>后</p>");
  });

  it("strips event handlers and non-whitelist attributes", () => {
    expect(
      sanitizeReviewNoteHtml(
        '<p onclick="alert(1)" class="x">文字</p><strong onmouseover="x">粗</strong>',
      ),
    ).toBe("<p>文字</p><strong>粗</strong>");
  });

  it("unwraps non-whitelist tags but keeps their text", () => {
    expect(sanitizeReviewNoteHtml("<h1>标题</h1><p>正文</p>")).toBe(
      "标题<p>正文</p>",
    );
    expect(sanitizeReviewNoteHtml("<div><span>纯文本</span></div>")).toBe(
      "纯文本",
    );
  });

  it("normalizes b/i aliases to strong/em", () => {
    expect(sanitizeReviewNoteHtml("<b>粗</b><i>斜</i>")).toBe(
      "<strong>粗</strong><em>斜</em>",
    );
  });

  it.each([
    ['<a href="javascript:alert(1)">链</a>', "<a>链</a>"],
    ['<a href="java\tscript:alert(1)">链</a>', "<a>链</a>"],
    ['<a href="java\n script:alert(1)">链</a>', "<a>链</a>"],
    ['<a href="data:text/html,x">链</a>', "<a>链</a>"],
  ])("keeps only safe href protocols: %s", (unsafe, expected) => {
    expect(sanitizeReviewNoteHtml('<a href="https://example.com">链</a>')).toBe(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">链</a>',
    );
    expect(sanitizeReviewNoteHtml(unsafe)).toBe(expected);
  });

  it("escapes stray angle brackets and round-trips entities", () => {
    expect(sanitizeReviewNoteHtml("数学 < 语文 & 英语")).toBe(
      "数学 &lt; 语文 &amp; 英语",
    );
    expect(sanitizeReviewNoteHtml("<p>a &lt; b &amp; c</p>")).toBe(
      "<p>a &lt; b &amp; c</p>",
    );
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
  });

  it("auto-closes misnested and unclosed tags", () => {
    expect(sanitizeReviewNoteHtml("<strong><em>交叉</strong></em>")).toBe(
      "<strong><em>交叉</em></strong>",
    );
    expect(sanitizeReviewNoteHtml("<p>未闭合")).toBe("<p>未闭合</p>");
  });

  it("keeps nested lists", () => {
    const input = "<ul><li>一</li><li><ul><li>二</li></ul></li></ul>";
    expect(sanitizeReviewNoteHtml(input)).toBe(input);
  });
});

describe("plainTextToReviewNoteHtml", () => {
  it("wraps plain lines as escaped paragraphs", () => {
    expect(plainTextToReviewNoteHtml("")).toBe("");
    expect(plainTextToReviewNoteHtml("   ")).toBe("");
    expect(plainTextToReviewNoteHtml("老师讲课很清楚，收获很大，推荐给学弟学妹。")).toBe(
      "<p>老师讲课很清楚，收获很大，推荐给学弟学妹。</p>",
    );
    expect(plainTextToReviewNoteHtml("第一段\n第二段")).toBe(
      "<p>第一段</p><p>第二段</p>",
    );
    expect(plainTextToReviewNoteHtml("数学 < 语文 & 英语")).toBe(
      "<p>数学 &lt; 语文 &amp; 英语</p>",
    );
  });
});

describe("reviewNotePlainText", () => {
  it("joins blocks with newlines like the editor getText()", () => {
    expect(reviewNotePlainText("<p>foo</p><p>bar</p>").trim()).toBe("foo\nbar");
    expect(
      reviewNotePlainText("<ul><li>一</li><li>二</li></ul>").trim(),
    ).toBe("一\n二");
    expect(reviewNotePlainText("<p>a<br>b</p>").trim()).toBe("a\nb");
  });
});

describe("sanitizeReviewNoteValue storage normalization", () => {
  it("keeps plain text submissions plain without inventing markup", () => {
    expect(sanitizeReviewNoteValue("  1234567890  ")).toEqual({
      comment: "1234567890",
      commentFormat: null,
    });
    expect(sanitizeReviewNoteValue("数学 < 语文，难度适中")).toEqual({
      comment: "数学 < 语文，难度适中",
      commentFormat: null,
    });
  });

  it("marks sanitized markup as html", () => {
    expect(sanitizeReviewNoteValue("<p><strong>加粗</strong>的正文内容</p>")).toEqual({
      comment: "<p><strong>加粗</strong>的正文内容</p>",
      commentFormat: "html",
    });
  });

  it("returns empty for markup-only submissions", () => {
    expect(sanitizeReviewNoteValue("<script>alert(1)</script>")).toEqual({
      comment: "",
      commentFormat: null,
    });
  });
});

describe("validateReviewNote with rich text", () => {
  it("measures the 10–1200 range on plain text after stripping tags", () => {
    expect(validateReviewNote("<p>短</p>")).toEqual({
      ok: false,
      error: "请填写至少 10 字补充说明",
    });
    expect(validateReviewNote("<p><strong>一二三四五六七八九十</strong></p>")).toEqual(
      {
        ok: true,
        comment: "<p><strong>一二三四五六七八九十</strong></p>",
        commentFormat: "html",
      },
    );
    expect(validateReviewNote(`<p>${"长".repeat(1201)}</p>`)).toEqual({
      ok: false,
      error: "补充说明不能超过 1200 字",
    });
  });

  it("rejects markup-only and markup-padded submissions as too short", () => {
    expect(validateReviewNote("<script>alert(1)</script>")).toEqual({
      ok: false,
      error: "请填写至少 10 字补充说明",
    });
    expect(
      validateReviewNote("<p>一二三</p>".repeat(1) + "<blockquote></blockquote>"),
    ).toEqual({ ok: false, error: "请填写至少 10 字补充说明" });
  });

  it("rejects absurdly long markup even when the text fits", () => {
    // 纯文本 1000 字未超 1200，但消毒后 HTML 超过存储上限。
    const markupHeavy = `<p>${"<strong>字</strong>".repeat(1000)}</p>`;
    expect(markupHeavy.length).toBeGreaterThan(REVIEW_NOTE_HTML_MAX_LENGTH);
    expect(validateReviewNote(markupHeavy)).toEqual({
      ok: false,
      error: "补充说明不能超过 1200 字",
    });
    // 原始投稿体积直接超限。
    expect(validateReviewNote(`<p>${"长".repeat(30000)}</p>`)).toEqual({
      ok: false,
      error: "补充说明不能超过 1200 字",
    });
  });
});
