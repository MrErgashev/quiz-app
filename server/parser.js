// server/parser.js

function parseQuestions(text) {
    const blocks = text.trim().split(/\n\s*\n/); // savollarni bo‘sh qator bilan ajratish
    return blocks.map(block => {
      const lines = block.trim().split("\n");
      const questionText = lines[0].replace(/^\d+\.\s*/, "").trim();
      const options = lines.slice(1).map(line => {
        const isCorrect = line.startsWith("*");
        const cleanLine = line.replace(/^\*?\s*[a-dA-D]\)\s*/, "").trim();
        return { text: cleanLine, isCorrect };
      });
      return {
        question: questionText,
        options
      };
    });
  }
  
  module.exports = { parseQuestions };
  