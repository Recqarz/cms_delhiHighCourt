require("dotenv").config();
 
const getProxy = async () => {
    try {
      const socksProxy = process.env.PROXY || null;
      return socksProxy;
    } catch (err) {
      console.log("Error fetching proxy:", err);
      throw err;
    }
  };
 
module.exports = {getProxy}  