const express = require("express");
const { scrapeCases, scrapePetAndRes, scrapeCaseType } = require("../controllers/caseController");
const { fetchJudgementCases } = require("../controllers/judgement");
const { fetchJudgementCasesNumber } = require("../controllers/judgementCaseNumber");
const { scrapeCaseUpdateType } = require("../controllers/update/update");

const router = express.Router();

router.post("/Advocatesearch", async (req, res) => {
    const { advocateName, year } = req.body;
    
    if (!advocateName || !year) {
        return res.status(400).json({ success: false, message: "Missing required parameters" });
    }

    try {
        const cases = await scrapeCases(advocateName, year);

        if (!cases || cases.length === 0) {
            return res.status(200).json({
                success: false,
                cases: [],
                message: "No cases found for the given parameters."
            });
        }

        res.status(200).json({ success: true, cases });
    } catch (error) {
        console.error("Error in scraping:", error);
        
        let errorMessage = "An unexpected error occurred.";
        if (error.message.includes("Failed to navigate")) {
            errorMessage = "Unable to access the court website. Please try again later.";
        } else if (error.message.includes("Failed to scrape")) {
            errorMessage = "Scraping failed after multiple attempts.";
        }

        res.status(500).json({ success: false, message: errorMessage });
    }
});


router.post("/PetAndRessearch", async (req, res) => {
    const { petAndRes, year } = req.body;
    
    if (!petAndRes || !year) {
        return res.status(400).json({ success: false, message: "Missing required parameters" });
    }

    try {
        const cases = await scrapePetAndRes(petAndRes, year);

        if (!cases || cases.length === 0) {
            return res.status(200).json({
                success: false,
                cases: [],
                message: "No cases found for the given parameters."
            });
        }

        res.status(200).json({ success: true, cases });
    } catch (error) {
        console.error("Error in scraping:", error);
        
        let errorMessage = "An unexpected error occurred.";
        if (error.message.includes("Failed to navigate")) {
            errorMessage = "Unable to access the court website. Please try again later.";
        } else if (error.message.includes("Failed to scrape")) {
            errorMessage = "Scraping failed after multiple attempts.";
        }

        res.status(500).json({ success: false, message: errorMessage });
    }
});


router.post("/scrapeCaseType", async (req, res) => {
    const { caseType, cno, year } = req.body;
    
    if (!caseType || !year) {
        return res.status(400).json({
            success: false,
            message: "Missing required parameters: caseType and year are required."
        });
    }

    try {
        const cases = await scrapeCaseType(caseType, cno, year);

        if (!cases || cases.length === 0) {
            return res.status(200).json({
                success: false,
                cases: [],
                message: "No cases found for the given parameters."
            });
        }

        res.status(200).json({ success: true, cases });
    } catch (error) {
        console.error("Error in show data:", error);
        
        let errorMessage = "An unexpected error occurred.";
        if (error.message.includes("Failed to navigate")) {
            errorMessage = "Unable to access the court website. Please try again later.";
        } else if (error.message.includes("Failed to scrape")) {
            errorMessage = "Scraping failed after multiple attempts.";
        }

        res.status(500).json({ success: false, message: errorMessage });
    }
});



router.post("/fetchJudgementCases", fetchJudgementCases);

router.post("/fetchJudgementCasesNumber", fetchJudgementCasesNumber);




module.exports = router;
