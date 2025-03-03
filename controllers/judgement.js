const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { launchBrowser } = require("../utils/browserlunch");

puppeteer.use(StealthPlugin());

const MAX_RETRIES = 3; // Maximum retry attempts

const fetchJudgementCases = async (req, res) => {
    const { fromDate, toDate } = req.body;
    if (!fromDate || !toDate) {
        return res.status(400).json({ error: "Missing required parameters: fromDate and toDate" });
    }

    let attempts = 0;
    let allCases = [];
    let seenSNos = new Set();
    let browser;

    while (attempts < MAX_RETRIES) {
        try {
            attempts++;
            console.log(`Attempt ${attempts}: Fetching cases from ${fromDate} to ${toDate}`);

            // Ensure no previous browser is open before launching a new one
            if (browser) {
                await browser.close();
            }

            // browser = await puppeteer.launch({
            //     headless: false,
            //     args: ["--no-sandbox", "--disable-setuid-sandbox"],
            // });
            browser = await launchBrowser(false);


            const page = await browser.newPage();
            page.setDefaultNavigationTimeout(30000); // Set 30s timeout to prevent hanging

            await page.goto("https://dhccaseinfo.nic.in/jsearch/", { waitUntil: "domcontentloaded" });

            await page.waitForSelector('input[name="Submit3"][value="     Judgement Date     "]', { visible: true });
            await page.click('input[name="Submit3"][value="     Judgement Date     "]');
            await new Promise(resolve => setTimeout(resolve, 2000));

            let frame = page;
            const iframeElement = await page.$("iframe");
            if (iframeElement) {
                const contentFrame = await iframeElement.contentFrame();
                if (contentFrame) {
                    frame = contentFrame;
                }
            }

            await frame.waitForSelector('input[name="frdate"]', { visible: true });
            await frame.waitForSelector('input[name="todate"]', { visible: true });

            await frame.evaluate(({ fromDate, toDate }) => {
                document.querySelector('input[name="frdate"]').value = fromDate;
                document.querySelector('input[name="todate"]').value = toDate;
            }, { fromDate, toDate });

            await frame.waitForSelector("#cap font", { visible: true });
            const captchaText = await frame.evaluate(() => document.querySelector("#cap font").innerText.trim());
            await frame.waitForSelector('input[name="captcha_code"]', { visible: true });

            await frame.evaluate((captcha) => {
                let inputField = document.querySelector('input[name="captcha_code"]');
                inputField.value = captcha;
            }, captchaText);

            await frame.waitForSelector('input[type="submit"][id="Submit"]', { visible: true });
            await frame.click('input[type="submit"][id="Submit"]');

            while (true) {
                await new Promise(res => setTimeout(res, 1000));
                await frame.waitForSelector("table tbody tr td", { visible: true });

                const caseData = await frame.evaluate(() => {
                    let caseDetails = [];
                    let rows = document.querySelectorAll("table tbody tr");

                    rows.forEach(row => {
                        let cells = row.querySelectorAll("td");
                        if (cells.length >= 2) {
                            let sNo = cells[0].innerText.trim();
                            let caseText = cells[1].innerText.trim();
                            let match = caseText.match(/([\w\s\.\(\)-]+)-(\d+)\/(\d+)\s*(\d{4}:DHC:\d+)/);

                            if (match) {
                                caseDetails.push({
                                    SNo: sNo,
                                    caseType: match[1],
                                    caseNumber: match[2],
                                    caseYear: match[3],
                                    caseDetails: match[4]
                                });
                            }
                        }
                    });

                    return caseDetails;
                });

                caseData.forEach(caseItem => {
                    if (!seenSNos.has(caseItem.SNo)) {
                        seenSNos.add(caseItem.SNo);
                        allCases.push(caseItem);
                    }
                });

                const nextExists = await frame.evaluate(() => {
                    let nextButton = [...document.querySelectorAll("a")].find(a => a.innerText.trim() === "Next");
                    if (nextButton) {
                        nextButton.click();
                        return true;
                    }
                    return false;
                });

                if (!nextExists) break;
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

            await browser.close();
            return res.json({ cases: allCases });

        } catch (error) {
            console.error(`Error on attempt ${attempts}:`, error.message);

            // Ensure browser is closed before retrying
            if (browser) {
                await browser.close();
                browser = null;
            }

            if (attempts >= MAX_RETRIES) {
                return res.status(500).json({ error: "Server unreachable after multiple attempts" });
            }

            console.log("Retrying in 5 seconds...");
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
};

module.exports = { fetchJudgementCases };
