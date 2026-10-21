const { createExamApp } = require("./app.js");

const port = Number(process.env.EXAM_BACKEND_PORT || process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("EXAM_BACKEND_PORT must be a valid TCP port");
}

createExamApp().listen(port, () => {
  console.log(`Exam backend running at http://localhost:${port}`);
});
