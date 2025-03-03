const express = require("express");
const { scrapeCases, scrapePetAndRes, scrapeCaseType } = require("../controllers/caseController");
const { fetchJudgementCases } = require("../controllers/judgement");
const { fetchJudgementCasesNumber } = require("../controllers/judgementCaseNumber");

const router = express.Router();

router.post("/Advocatesearch", async (req, res) => {
  const { advocateName, year } = req.body;
  try {
    const cases = await scrapeCases(advocateName, year);
    res.json({ success: true, cases });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/PetAndRessearch", async (req, res) => {
    const { petAndRes, year } = req.body;
    // console.log(petAndRes,year);
    if (!petAndRes || !year) {
        return res.status(400).json({ success: false, message: "Missing required parameters" });
    }

    try {
        const cases = await scrapePetAndRes(petAndRes, year);
        res.json({ success: true, cases });
    } catch (error) {
        console.error("Error in scraping:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

router.post("/scrapeCaseType", async (req, res) => {
    const {caseType, cno, year } = req.body;
    // console.log(caseType , cno,year);
    if (!caseType || !year) {
        return res.status(400).json({ success: false, message: "Missing required parameters" });
    }

    try {
        const cases = await scrapeCaseType(caseType, cno, year);
        res.json({ success: true, cases });
    } catch (error) {
        console.error("Error in scraping:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});


router.post("/fetchJudgementCases", fetchJudgementCases);

router.post("/fetchJudgementCasesNumber", fetchJudgementCasesNumber);




module.exports = router;
