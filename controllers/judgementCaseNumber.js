const { default: axios } = require("axios");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { uploadFileToS3 } = require("../utils/s3");
const path = require("path");
const fs = require("fs");
const { launchBrowser } = require("../utils/browserlunch");

puppeteer.use(StealthPlugin());

const BASE_URL = "https://dhccaseinfo.nic.in/jsearch/";

const fetchJudgementCasesNumber = async (req, res) => {
  let browser;
  try {
    const { caseType, caseNumber, caseYear } = req.body;
    if (!caseType || !caseNumber || !caseYear) {
      return res
        .status(400)
        .json({ error: "Missing required parameter: check again please" });
    }

    // browser = await puppeteer.launch({
    //   headless: false,
    //   args: ["--no-sandbox", "--disable-setuid-sandbox"],
    // });

    browser = await launchBrowser(false);


    const page = await browser.newPage();
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('input[name="Submit"]', { visible: true });

    await page.click('input[name="Submit"]');
    await new Promise((res) => setTimeout(res, 2000));

    let frame = page;
    const iframeElement = await page.$("iframe");
    if (iframeElement) {
      const contentFrame = await iframeElement.contentFrame();
      if (contentFrame) frame = contentFrame;
    }

    await frame.waitForSelector('select[name="ctype"]', { visible: true });
    const options = await frame.$$eval('select[name="ctype"] option', (opts) =>
      opts.map((opt) => ({ text: opt.textContent.trim(), value: opt.value }))
    );

    const selectedOption = options.find((option) => option.text === caseType);
    if (!selectedOption) {
      return res.status(400).json({
        error: `Invalid case type: ${caseType}. Available options are: ${options
          .map((o) => o.text)
          .join(", ")}`,
      });
    }

    await frame.select('select[name="ctype"]', selectedOption.value);
    await new Promise((res) => setTimeout(res, 2000));
    await frame.type('input[name="cnum"]', caseNumber);
    await frame.select('select[name="cyear"]', caseYear);

    const captchaText = await frame.$eval("#cap font", (el) =>
      el.textContent.trim()
    );
    console.log("CAPTCHA Text:", captchaText);

    await frame.type('input[name="captcha_code"]', captchaText);
    await frame.click('input[name="btnSubmit"]');
    await frame.waitForSelector(
      'table[width="100%"][border="1"][bgcolor="#FFFFFF"]',
      { visible: true }
    );

    let tables = await frame.$$(
      "table[width='100%'][border='1'][bgcolor='#FFFFFF']"
    );

    let allCases = [];

    for (const table of tables) {
      let caseData = await table.$$eval("tbody tr", (rows) => {
        return rows
          .map((row) => {
            const cols = row.querySelectorAll("td");
            if (cols.length < 5) return null;

            const fullCaseNumber = cols[1]?.innerText
              ?.trim()
              .replace(/\s+/g, " ");
            const caseNumberParts = fullCaseNumber.split(/[\/\s]+/);

            if (caseNumberParts.length < 3) return null; // Ensure valid format

            const caseType = caseNumberParts[0];
            const caseNumber = caseNumberParts[1];
            const caseYear = caseNumberParts[2];

            let judgementDate =
              cols[2]?.innerText?.trim().split("(pdf)")[0].trim() || "N/A";

            const pdfElement = cols[2]?.querySelector("a");
            let judgementPDF = pdfElement
              ? pdfElement.getAttribute("href")
              : null;

            return {
              serialNumber: cols[0]?.innerText?.trim() || "N/A",
              caseType,
              caseNumber,
              caseYear,
              judgementDate,
              party: cols[3]?.innerText?.trim() || "N/A",
              corrigendum: cols[4]?.innerText?.trim() || "N/A",
              judgementPDF,
            };
          })
          .filter((caseItem) => caseItem !== null);
      });

      allCases.push(...caseData);
    }

    // Open new page for handling qrcode.php redirection
    const extraPage = await browser.newPage();

    for (const caseItem of allCases) {
      if (caseItem.judgementPDF) {
        let fullPDFUrl = new URL(caseItem.judgementPDF, BASE_URL).href;

        // If the link contains 'qrcode.php', open it and extract real PDF URL
        if (fullPDFUrl.includes("qrcode.php")) {
          try {
            await extraPage.goto(fullPDFUrl, { waitUntil: "domcontentloaded" });
            const fileName = `judgement_${caseItem.caseType}_${caseItem.caseNumber}_${caseItem.caseYear}.pdf`;
            const s3Link = await downloadAndUploadToS3(fullPDFUrl, fileName);
            caseItem.s3_Link = s3Link || "Download failed";
            await new Promise((res) => setTimeout(res, 2000));
          } catch (uploadError) {
            console.error("S3 Upload error:", uploadError);
            caseItem.s3_Link = "N/A";
          }
        } else {
          caseItem.s3_Link = "No PDF available";
        }

        // Download and upload to S3
        if (fullPDFUrl) {
          try {
            const fileName = `judgement_${caseItem.caseType}_${caseItem.caseNumber}_${caseItem.caseYear}.pdf`;
            const s3Link = await downloadAndUploadToS3(fullPDFUrl, fileName);
            caseItem.s3_Link = s3Link || "Download failed";
          } catch (uploadError) {
            console.error("S3 Upload error:", uploadError);
            caseItem.s3_Link = "N/A";
          }
        } else {
          caseItem.s3_Link = "No PDF available";
        }
      } else {
        caseItem.s3_Link = "No PDF available";
      }

      delete caseItem.judgementPDF;
    }

    res.status(200).json({ cases: allCases });
  } catch (error) {
    console.error("Error fetching cases:", error);
    res.status(500).json({ error: "Internal Server Error" });
  } finally {
    // Close the browser in the finally block to ensure it's closed regardless of errors
    if (browser) {
      await browser.close();
    }
  }
};

const downloadAndUploadToS3 = async (url, fileName) => {
  try {
    if (!url) return null;
    fileName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const outputPath = path.join(__dirname, "downloads", fileName);

    if (!fs.existsSync(path.dirname(outputPath))) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    }

    const response = await axios({
      url,
      method: "GET",
      responseType: "stream",
    });
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    const s3Response = await uploadFileToS3(outputPath, fileName);
    fs.unlinkSync(outputPath);
    return s3Response.Location;
  } catch (error) {
    console.error("File download/upload failed:", error);
    return null;
  }
};

module.exports = { fetchJudgementCasesNumber };
