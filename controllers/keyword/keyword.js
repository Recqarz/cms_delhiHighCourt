const { launchBrowser } = require("../../utils/browserlunch");


const scrapeKeyWordPetAndRes = async (
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
  
        const SearchKeyword  = petAndRes;
        console.log("this is searh", SearchKeyword)


        allCases = allCases.filter((ele) => 
            ele.respondent && ele.respondent.toLowerCase().includes(petAndRes.toLowerCase())
        );
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
  


module.exports = {scrapeKeyWordPetAndRes}