const express = require("express");
const bodyParser = require("body-parser");
const caseRoutes = require("./routes/caseRoutes");

const app = express();

app.use(bodyParser.json());
app.use("/api", caseRoutes);

const PORT = process.env.PORT || 3000;
app.get("/health", (req, res) => {
  res.send("Welcome to the case higcourt API");
});
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
