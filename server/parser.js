// server/parser.js

// Javob variantlaridan a), b), *a), *b) kabi prefixlarni tozalash
function cleanOptionPrefix(text) {
  if (typeof text !== "string") return text;
  // Boshidagi *a), a), A), *A) va hokazolarni olib tashlash
  return text.replace(/^\*?\s*[a-dA-D]\)\s*/, "").trim();
}

function parseQuestions(text) {
    const blocks = text.trim().split(/\n\s*\n/); // savollarni bo'sh qator bilan ajratish
    return blocks.map(block => {
      const lines = block.trim().split("\n");
      const questionText = lines[0].replace(/^\d+\.\s*/, "").trim();
      const options = lines.slice(1).map(line => {
        const isCorrect = line.startsWith("*");
        const cleanLine = cleanOptionPrefix(line.replace(/^\*/, ""));
        return { text: cleanLine, isCorrect };
      });
      return {
        question: questionText,
        options
      };
    });
  }

  module.exports = { parseQuestions, cleanOptionPrefix };
  