const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

const { uploadFileToS3 } = require("../utils/s3");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { launchBrowser } = require("../utils/browserlunch");

puppeteer.use(StealthPlugin());

const MAX_TABS = 10;
const BASE_URL = "https://delhihighcourt.nic.in/court/case";

// Scrape Case Data
const scrapeCases = async (advocateName, year,  maxRetries = 8,
  retryDelay = 5000) => {
  let browser;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
  try {
    // browser = await puppeteer.launch({
    //   headless: false,
    //   args: ["--no-sandbox", "--disable-setuid-sandbox"],
    //   timeout: 60000,
    // });

    browser = await launchBrowser(false);


    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });


    // Function to handle page navigation with retries
    const gotoWithRetry = async (url) => {
      for (let i = 0; i < maxRetries; i++) {
        try {
          // console.log(`Navigating to ${url}, attempt ${i + 1}...`);
          await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
          // console.log(`Successfully navigated to ${url}`);
          return; // Exit if successful
        } catch (error) {
          console.error(`Failed to navigate to ${url}, attempt ${i + 1}:`, error.message);
          // Check for specific error messages
          if (error.message.includes('ERR_FAILED') || 
              error.message.includes('ERR_CONNECTION_TIMED_OUT') || 
              error.message.includes('This site can’t be reached')) {
            console.log("Retrying the page due to network failure...");
          }
          if (i < maxRetries - 1) {
            console.log(`Retrying in ${retryDelay / 1000} seconds...`);
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
          } else {
            throw new Error(`Failed to navigate to ${url} after ${maxRetries} attempts`);
          }
        }
      }
    };

    const BASE_URL = `https://delhihighcourt.nic.in/court/case?&adv=${advocateName}&cyear=${year}`;
        await gotoWithRetry(BASE_URL); 

    // await page.goto(BASE_URL, { waitUntil: "networkidle2" });

    // Ensure input fields are available before interacting
    await page.waitForSelector("form:nth-of-type(3) input[name='adv']", {
      visible: true,  timeout: 60000
    });
    await page.type("form:nth-of-type(3) input[name='adv']", advocateName);

    await page.waitForSelector("form:nth-of-type(3) select[name='cyear']", {
      visible: true,
    });
    await page.select("form:nth-of-type(3) select[name='cyear']", year);

    await Promise.all([
      page.click("form:nth-of-type(3) button[type='submit']"),
      page.waitForNavigation({ waitUntil: "networkidle2" }),
    ]);

    let allCases = [];

    // Scrape Data
    const scrapeCurrentPage = async (page) => {
      return await page.evaluate(() => {
        const cases = [];
        document.querySelectorAll("table tr").forEach((row) => {
          const columns = row.querySelectorAll("td");
          if (columns.length > 3) {
            let caseNumberRaw = columns[1]?.innerText.trim();
            let petitionerRaw = columns[2]?.innerText.trim();
            let listingDateRaw = columns[3]?.innerText.trim();

            const diaryMatch = caseNumberRaw?.match(/^([A-Z.\s()\d/]+)/);
            const diaryNo = diaryMatch ? diaryMatch[1]?.trim() : caseNumberRaw;
            const statusMatch = caseNumberRaw?.match(/\[(.*?)\]/);
            const status = statusMatch ? statusMatch[1]?.trim() : "Pending";

            // Extracting caseType, caseNumber, and caseYear
            const caseParts = diaryNo.match(/^(.*?)[\s]+(\d+)\s*\/\s*(\d{4})$/);
            const caseType = caseParts ? caseParts[1]?.trim() : diaryNo;
            const caseNumber = caseParts ? caseParts[2]?.trim() : "Unknown";
            const caseYear = caseParts ? caseParts[3]?.trim() : "Unknown";

            const respondentParts = petitionerRaw?.split("Vs.");
            const petitioner = respondentParts[0]?.trim();
            const respondent =
              respondentParts[1]?.replace(/Advocate\s*:.*/, "").trim() ||
              "Unknown";

            const advocateMatch = petitionerRaw?.match(/Advocate\s*:\s*(.*)/);
            const advocate = advocateMatch ? advocateMatch[1]?.trim() : "";

            const courtMatch = listingDateRaw?.match(/Court No. : (\d+)/);
            const nextDateMatch = listingDateRaw?.match(
              /Next Date:(\d{2}\/\d{2}\/\d{4})/
            );
            const lastDateMatch = listingDateRaw?.match(
              /Last Date: (\d{2}\/\d{2}\/\d{4})/
            );

            const courtNo = courtMatch ? courtMatch[1] : "N/A";
            const nextDate = nextDateMatch ? nextDateMatch[1] : "N/A";
            const lastDate = lastDateMatch ? lastDateMatch[1] : "N/A";

            const orderLinkElement = row.querySelector(
              'a[style*="color:blue"]'
            );
            const orderLink = orderLinkElement ? orderLinkElement.href : null;

            cases.push({
              caseType,
              caseNumber,
              caseYear,
              status,
              petitioner,
              respondent,
              advocate,
              courtNo,
              nextDate,
              lastDate,
              orderLink,
            });
          }
        });
        return cases;
      });
    };

    // Loop through pages to scrape data
    while (true) {
      const caseDetails = await scrapeCurrentPage(page);
      allCases = allCases.concat(caseDetails);

      const casesWithOrders = caseDetails.filter((caseData) => caseData.orderLink);
      await processCasesInBatches(casesWithOrders, MAX_TABS, browser);

      const nextButton = await page.$(".btn-warning.pull-left");
      if (nextButton) {
        let nextPageUrl = await page.evaluate((btn) => btn.href, nextButton);
        // console.log(`Next Page URL: ${nextPageUrl}`);
        if (!nextPageUrl) {
          console.log("No more pages to scrape.");
          break;
        }

        // console.log(`Attempting to navigate to next page...`);
        await gotoWithRetry(nextPageUrl);

        // console.log(`Successfully navigated to the next page.`);
      } else {
        console.log("No 'Next' button found. Exiting pagination.");
        break;
      }
    }
    // Clean up unnecessary orderLink details
    allCases = allCases.map((ele) => {
      let nele = ele;
      delete nele.orderLink;
      if (nele.orderDetails) {
        nele.orderDetails = nele.orderDetails.map((sele) => {
          let nsele = sele;
          delete nsele.downloadLink;
          return nsele;
        });
      }
      return nele;
    });

    return allCases;
  } catch (error) {
    console.error("Error in scraping:", error.message);
    if (attempt < maxRetries) {
      console.log(`Retrying in ${retryDelay / 1000} seconds...`);
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    } else {
      throw new Error(`Failed to scrape Advocate ${maxRetries} attempts: ${error.message}`);
    }
  }finally {
    if (browser) {
      await browser.close();
    }
  }
}
};


const scrapePetAndRes = async (
  petAndRes,
  year,
  maxRetries = 8,
  retryDelay = 5000
) => {
  let browser;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // console.log(`Attempting to launch browser, attempt ${attempt}...`);
      // browser = await puppeteer.launch({
      //   headless: false,
      //   args: ["--no-sandbox", "--disable-setuid-sandbox"],
      //   timeout: 60000,
      // });

      browser = await launchBrowser(false);


      const page = await browser.newPage();
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
      });

      // Function to handle page navigation with retries
      const gotoWithRetry = async (url) => {
        for (let i = 0; i < maxRetries; i++) {
          try {
            // console.log(`Navigating to ${url}, attempt ${i + 1}...`);
            await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
            // console.log(`Successfully navigated to ${url}`);
            return; // Exit if successful
          } catch (error) {
            console.error(`Failed to navigate to ${url}, attempt ${i + 1}:`, error.message);
            // Check for specific error messages
            if (error.message.includes('ERR_FAILED') || 
                error.message.includes('ERR_CONNECTION_TIMED_OUT') || 
                error.message.includes('This site can’t be reached')) {
              console.log("Retrying the page due to network failure...");
            }
            if (i < maxRetries - 1) {
              console.log(`Retrying in ${retryDelay / 1000} seconds...`);
              await new Promise((resolve) => setTimeout(resolve, retryDelay));
            } else {
              throw new Error(`Failed to navigate to ${url} after ${maxRetries} attempts`);
            }
          }
        }
      };

      // Updated BASE_URL
      const BASE_URL = `https://delhihighcourt.nic.in/court/case?party=${petAndRes}&cyear=${year}`;
      await gotoWithRetry(BASE_URL);  // Initial page load

      // Ensure input fields are available before interacting
      await page.waitForSelector("form:nth-of-type(2) input[name='party']", {
        visible: true,
        timeout: 60000,
      });
      await page.type("form:nth-of-type(2) input[name='party']", petAndRes);

      await page.waitForSelector("form:nth-of-type(2) select[name='cyear']", {
        visible: true,
      });
      await page.select("form:nth-of-type(2) select[name='cyear']", year);

      await Promise.all([
        page.click("form:nth-of-type(2) button[type='submit']"),
        page.waitForNavigation({ waitUntil: "networkidle2" }),
      ]);

      let allCases = [];

      // Scrape Data
      const scrapeCurrentPage = async (page) => {
        return await page.evaluate(() => {
          const cases = [];
          document.querySelectorAll("table tr").forEach((row) => {
            const columns = row.querySelectorAll("td");
            if (columns.length > 3) {
              let caseNumberRaw = columns[1]?.innerText.trim();
              let petitionerRaw = columns[2]?.innerText.trim();
              let listingDateRaw = columns[3]?.innerText.trim();

              const diaryMatch = caseNumberRaw?.match(/^([A-Z.\s()\d/]+)/);
              const diaryNo = diaryMatch ? diaryMatch[1]?.trim() : caseNumberRaw;
              const statusMatch = caseNumberRaw?.match(/\[(.*?)\]/);
              const status = statusMatch ? statusMatch[1]?.trim() : "Pending";

              // Extract caseType, caseNumber, and caseYear
              const caseParts = diaryNo.match(/^(.*?)[\s]+(\d+)\s*\/\s*(\d{4})$/);
              const caseType = caseParts ? caseParts[1]?.trim() : diaryNo;
              const caseNumber = caseParts ? caseParts[2]?.trim() : "Unknown";
              const caseYear = caseParts ? caseParts[3]?.trim() : "Unknown";

              const respondentParts = petitionerRaw?.split("Vs.");
              const petitioner = respondentParts[0]?.trim();
              const respondent = respondentParts[1]?.replace(/Advocate\s*:.*/, "").trim() || "Unknown";

              const advocateMatch = petitionerRaw?.match(/Advocate\s*:\s*(.*)/);
              const advocate = advocateMatch ? advocateMatch[1]?.trim() : "";

              const courtMatch = listingDateRaw?.match(/Court No. : (\d+)/);
              const nextDateMatch = listingDateRaw?.match(/Next\s+(\d{2}\/\d{2}\/\d{4})/);
              const lastDateMatch = listingDateRaw?.match(/Last Date: (\d{2}\/\d{2}\/\d{4})/);

              const courtNo = courtMatch ? courtMatch[1] : "N/A";
              const nextDate = nextDateMatch ? nextDateMatch[1] : "N/A";
              const lastDate = lastDateMatch ? lastDateMatch[1] : "N/A";

              const orderLinkElement = row.querySelector('a[style*="color:blue"]');
              const orderLink = orderLinkElement ? orderLinkElement.href : null;

              cases.push({
                caseType,
                caseNumber,
                caseYear,
                status,
                petitioner,
                respondent,
                advocate,
                courtNo,
                nextDate,
                lastDate,
                orderLink,
              });
            }
          });
          return cases;
        });
      };

      // Loop through pages to scrape data
      while (true) {
        const caseDetails = await scrapeCurrentPage(page);
        allCases = allCases.concat(caseDetails);

        const casesWithOrders = caseDetails.filter((caseData) => caseData.orderLink);
        await processCasesInBatches(casesWithOrders, MAX_TABS, browser);

        const nextButton = await page.$(".btn-warning.pull-left");
        if (nextButton) {
          let nextPageUrl = await page.evaluate((btn) => btn.href, nextButton);
          // console.log(`Next Page URL: ${nextPageUrl}`);
          if (!nextPageUrl) {
            console.log("No more pages to scrape.");
            break;
          }

          // console.log(`Attempting to navigate to next page...`);
          await gotoWithRetry(nextPageUrl);

          // console.log(`Successfully navigated to the next page.`);
        } else {
          console.log("No 'Next' button found. Exiting pagination.");
          break;
        }
      }

      // Clean up unnecessary orderLink details
      allCases = allCases.map((ele) => {
        let nele = ele;
        delete nele.orderLink;
        if (nele.orderDetails) {
          nele.orderDetails = nele.orderDetails.map((sele) => {
            let nsele = sele;
            delete nsele.downloadLink;
            return nsele;
          });
        }
        return nele;
      });

      return allCases;
    } catch (error) {
      console.error("Error in scraping:", error.message);

      if (attempt < maxRetries) {
        console.log(`Retrying in ${retryDelay / 1000} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      } else {
        throw new Error(`Failed to scrape petitioner and respondent data after ${maxRetries} attempts: ${error.message}`);
      }
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }
};

const scrapeCaseType = async (caseType, cno, year, maxRetries = 8,
  retryDelay = 5000) => {
  let browser;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {

  try {
    browser = await launchBrowser(false);

    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    const gotoWithRetry = async (url) => {
      for (let i = 0; i < maxRetries; i++) {
        try {
          // console.log(`Navigating to ${url}, attempt ${i + 1}...`);
          await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
          // console.log(`Successfully navigated to ${url}`);
          return; // Exit if successful
        } catch (error) {
          console.error(`Failed to navigate to ${url}, attempt ${i + 1}:`, error.message);
          // Check for specific error messages
          if (error.message.includes('ERR_FAILED') || 
              error.message.includes('ERR_CONNECTION_TIMED_OUT') || 
              error.message.includes('This site can’t be reached')) {
            console.log("Retrying the page due to network failure...");
          }
          if (i < maxRetries - 1) {
            console.log(`Retrying in ${retryDelay / 1000} seconds...`);
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
          } else {
            throw new Error(`Failed to navigate to ${url} after ${maxRetries} attempts`);
          }
        }
      }
    };

    const BASE_URL = `https://delhihighcourt.nic.in/court/case?&ctype=${caseType}&cno=${cno}&cyear=${year}`;
    await gotoWithRetry(BASE_URL); 

    await page.goto(BASE_URL, { waitUntil: "networkidle2" });

    // Wait for the select element to appear
    await page.waitForSelector("select[name='ctype']");

    // Select the option by visible text
    await page.evaluate((caseType) => {
      const select = document.querySelector("select[name='ctype']");
      const options = Array.from(select.options);
      const optionToSelect = options.find(
        (option) => option.textContent.trim() === caseType
      );

      if (optionToSelect) {
        optionToSelect.selected = true;
        select.dispatchEvent(new Event("change"));
      }
    }, caseType);

    await page.waitForSelector("input[name='cno']");
    await page.$eval("input[name='cno']", (el) => (el.value = ""));
    if (cno) {
      await page.type("input[name='cno']", cno, { delay: 100 });
    }

    await page.waitForSelector("select[name='cyear']");
    await page.select("select[name='cyear']", year);

    await Promise.all([
      page.click('button[type="submit"], input[type="submit"]'),
      page.waitForNavigation({ waitUntil: "networkidle2" }),
    ]);

    let allCases = [];

    // Scrape Data
    const scrapeCurrentPage = async (page) => {
      return await page.evaluate(() => {
        const cases = [];
        document.querySelectorAll("table tr").forEach((row) => {
          const columns = row.querySelectorAll("td");
          if (columns.length > 3) {
            let caseNumberRaw = columns[1]?.innerText.trim();
            let petitionerRaw = columns[2]?.innerText.trim();
            let listingDateRaw = columns[3]?.innerText.trim();

            const diaryMatch = caseNumberRaw?.match(/^([A-Z.\s()\d/]+)/);
            const diaryNo = diaryMatch ? diaryMatch[1]?.trim() : caseNumberRaw;
            const statusMatch = caseNumberRaw?.match(/\[(.*?)\]/);
            const status = statusMatch ? statusMatch[1]?.trim() : "Pending";

            // Extracting caseType, caseNumber, and caseYear
            const caseParts = diaryNo.match(/^(.*?)[\s]+(\d+)\s*\/\s*(\d{4})$/);
            const caseType = caseParts ? caseParts[1]?.trim() : diaryNo;
            const caseNumber = caseParts ? caseParts[2]?.trim() : "Unknown";
            const caseYear = caseParts ? caseParts[3]?.trim() : "Unknown";

            const respondentParts = petitionerRaw?.split("Vs.");
            const petitioner = respondentParts[0]?.trim();
            const respondent =
              respondentParts[1]?.replace(/Advocate\s*:.*/, "").trim() ||
              "Unknown";

            const advocateMatch = petitionerRaw?.match(/Advocate\s*:\s*(.*)/);
            const advocate = advocateMatch ? advocateMatch[1]?.trim() : "";

            const courtMatch = listingDateRaw?.match(/Court No. : (\d+)/);
            const nextDateMatch = listingDateRaw?.match(
              /Next Date:(\d{2}\/\d{2}\/\d{4})/
            );
            const lastDateMatch = listingDateRaw?.match(
              /Last Date: (\d{2}\/\d{2}\/\d{4})/
            );

            const courtNo = courtMatch ? courtMatch[1] : "N/A";
            const nextDate = nextDateMatch ? nextDateMatch[1] : "N/A";
            const lastDate = lastDateMatch ? lastDateMatch[1] : "N/A";

            const orderLinkElement = row.querySelector(
              'a[style*="color:blue"]'
            );
            const orderLink = orderLinkElement ? orderLinkElement?.href : null;

            cases.push({
              caseType,
              caseNumber,
              caseYear,
              status,
              petitioner,
              respondent,
              advocate,
              courtNo,
              nextDate,
              lastDate,
              orderLink,
            });
          }
        });
        return cases;
      });
    };

    // Loop through pages to scrape data
    while (true) {
      const caseDetails = await scrapeCurrentPage(page);
      allCases = allCases.concat(caseDetails);

      const casesWithOrders = caseDetails.filter((caseData) => caseData.orderLink);
      await processCasesInBatches(casesWithOrders, MAX_TABS, browser);

      const nextButton = await page.$(".btn-warning.pull-left");
      if (nextButton) {
        let nextPageUrl = await page.evaluate((btn) => btn.href, nextButton);
        // console.log(`Next Page URL: ${nextPageUrl}`);
        if (!nextPageUrl) {
          console.log("No more pages to scrape.");
          break;
        }

        // console.log(`Attempting to navigate to next page...`);
        await gotoWithRetry(nextPageUrl);

        // console.log(`Successfully navigated to the next page.`);
      } else {
        console.log("No 'Next' button found. Exiting pagination.");
        break;
      }
    }


    // Clean up unnecessary orderLink details
    allCases = allCases.map((ele) => {
      let nele = ele;
      delete nele.orderLink;
      if (nele.orderDetails) {
        nele.orderDetails = nele.orderDetails.map((sele) => {
          let nsele = sele;
          delete nsele.downloadLink;
          return nsele;
        });
      }
      return nele;
    });

    return allCases;
  }catch (error) {
    console.error("Error in scraping:", error.message);

    if (attempt < maxRetries) {
      console.log(`Retrying in ${retryDelay / 1000} seconds...`);
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    } else {
      throw new Error(`Failed to scrape caseType ${maxRetries} attempts: ${error.message}`);
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

};

// Download File
const downloadFile = async (url, outputPath) => {
  return new Promise(async (resolve, reject) => {
    let retries = 3;
    while (retries > 0) {
      try {
        // console.log(`Downloading file: ${url}`);

        // Wait 1 second before starting download (Fixes "Failed to load PDF document" error)
        await new Promise((res) => setTimeout(res, 1000));

        const response = await axios({
          url,
          method: "GET",
          responseType: "stream",
        });

        if (response.status !== 200) {
          throw new Error(`HTTP error: ${response.status}`);
        }

        const writer = fs.createWriteStream(outputPath);
        response.data.pipe(writer);

        writer.on("finish", async () => {
          writer.close();

          // Check if file is valid
          if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
            // console.log(`File downloaded successfully: ${outputPath}`);
            resolve(outputPath);
          } else {
            console.error(`Downloaded file is empty or invalid: ${outputPath}`);
            fs.unlinkSync(outputPath); // Delete corrupt file
            retries--;
            if (retries > 0) {
              console.log(`Retrying download in 2 seconds... (${retries} attempts left)`);
              await new Promise((res) => setTimeout(res, 2000));
            } else {
              reject(new Error("File download failed after multiple retries"));
            }
          }
        });

        writer.on("error", (err) => {
          console.error("File write error:", err.message);
          reject(err);
        });

        return; // Exit loop if download starts successfully
      } catch (error) {
        console.error("Download error:", error.message);
        retries--;
        if (retries === 0) {
          reject(new Error("Failed to download file after multiple attempts"));
        } else {
          console.log(`Retrying in 2 seconds... (${retries} attempts left)`);
          await new Promise((res) => setTimeout(res, 2000));
        }
      }
    }
  });
};


// Process cases in batches
const processCasesInBatches = async (cases, batchSize, browser) => {
  for (let i = 0; i < cases.length; i += batchSize) {
    const batch = cases.slice(i, i + batchSize);

    const tabPromises = batch.map(async (caseData) => {
      let retries = 0;
      const MAX_RETRIES = 3;
      while (retries < MAX_RETRIES) {
        const orderPage = await browser.newPage();
        try {
          await orderPage.goto(caseData.orderLink, {
            waitUntil: "networkidle2",
            timeout: 60000,
          });

          const orderDetails = await orderPage.evaluate(() => {
            const orders = [];
            document.querySelectorAll("ul.grid li").forEach((order) => {
              const orderNumber =
                order.querySelector(".sr-no")?.innerText.trim() || "";
              const caseTitle =
                order.querySelector(".title a")?.innerText.trim() || "";
              const orderDate =
                order.querySelector(".width-15")?.innerText.trim() || "";
              const corrigendum =
                order.querySelector(".width-24")?.innerText.trim() || "";
              const hindiOrder =
                order
                  .querySelector(".width-24 title al last")
                  ?.innerText.trim() || "";
              const downloadLink = order.querySelector(".title a")?.href || "";

              // Extract caseType, caseNo, and caseYear using regex
              const caseMatch = caseTitle.match(/^(.*?)\s+(\d+)\/(\d{4})$/);
              const caseType = caseMatch ? caseMatch[1] : "";
              const caseNo = caseMatch ? caseMatch[2] : "";
              const caseYear = caseMatch ? caseMatch[3] : "";

              orders.push({
                orderNumber,
                caseType,
                caseNo,
                caseYear,
                orderDate,
                corrigendum,
                hindiOrder,
                downloadLink,
              });
            });
            return orders;
          });

          caseData.orderDetails = orderDetails;

          const delay = (ms) =>
            new Promise((resolve) => setTimeout(resolve, ms));

          // Function to try deleting a file with retries
          const tryDeleteFile = async (filePath) => {
            let retries = 3;
            while (retries > 0) {
              try {
                if (fs.existsSync(filePath)) {
                  fs.unlinkSync(filePath);
                  //   console.log(`Deleted file: ${filePath}`);
                  return; // Exit retry loop after successfully deleting the file
                } else {
                  console.log(`File not found: ${filePath}`);
                  return; // Exit if the file doesn't exist
                }
              } catch (error) {
                console.error(`Error deleting file: ${filePath}`, error);
                retries--;
                if (retries > 0) {
                  console.log(
                    `Retrying deletion of file: ${filePath} (${retries} attempts left)`
                  );
                } else {
                  console.error(
                    `Failed to delete file after multiple attempts: ${filePath}`
                  );
                }
                await delay(1000); // Wait 1 second before retrying
              }
            }
          };

          // Main logic to process orders and files
          for (const order of orderDetails) {
            const pdfUrl = order.downloadLink;
            const fileName = path.basename(pdfUrl);
            const outputPath = path.join(__dirname, fileName);

            try {
              // Download the file
              await downloadFile(pdfUrl, outputPath);

              // Check if the file exists after download
              if (!fs.existsSync(outputPath)) {
                console.error(`File not found after download: ${outputPath}`);
                continue; // Skip processing if the file is not found
              }

              //   console.log(`File downloaded successfully: ${outputPath}`);

              // Upload the file to S3
              const s3Response = await uploadFileToS3(outputPath, fileName);
              //   console.log(`Uploaded to S3: ${s3Response.Location}`);

              // Attach the S3 link to the order
              order.s3Link = s3Response.Location;
              // Try to delete the local file after uploading to S3 with retries
              await tryDeleteFile(outputPath);
            } catch (error) {
              console.error(
                `Error processing file ${fileName}:`,
                error.message
              );
            }
          }

          await orderPage.close();
          break;
        } catch (error) {
          retries++;
          await orderPage.close();
          if (retries >= MAX_RETRIES) {
            console.error(
              `Failed to fetch order details after ${MAX_RETRIES} attempts: ${caseData.orderLink}`
            );
          }
        }
      }
    });

    await Promise.all(tabPromises);
  }
};

module.exports = { scrapeCases, scrapePetAndRes, scrapeCaseType };
