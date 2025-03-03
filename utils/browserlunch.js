const puppeteer = require("puppeteer");
// const proxyChain = require("proxy-chain");
const fs = require("fs");
 
const launchBrowser = async (headless = false, proxy) => {
  let executablePath;
 
  if (process.platform === "win32") {
    executablePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  } else if (process.platform === "linux") {
    executablePath = "/usr/bin/google-chrome";
    const { spawn } = require("child_process");
 
    if (!fs.existsSync(executablePath)) {
      throw new Error("Google Chrome is not installed.");
    }
 
    try {
      const xvfbProcess = spawn("/usr/bin/Xvfb", [":99", "-screen", "0", "1280x720x24"], {
        stdio: "ignore",
        detached: true,
      });
      xvfbProcess.unref();
    } catch (err) {
      console.error("Failed to start Xvfb:", err.message);
      throw err;
    }
 
    process.env.DISPLAY = ":99";
  } else {
    throw new Error("Unsupported operating system");
  }
 
//   const anonymizedProxy = await proxyChain.anonymizeProxy(proxy);
 
  return puppeteer.launch({
    headless,
    executablePath,
    args: [
    //   `--proxy-server=${anonymizedProxy}`,
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-popup-blocking",
      "--disable-gpu",
      "--headless"
    ],
  });
};
 
module.exports = {launchBrowser}