// Probe several plausible ABB library / search APIs to find documents for a product.
const PID = process.argv[2] || "1SAP180400R0001";
const CID = process.argv[3] || "9AAF636742";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

async function probe(url: string, extraHeaders: Record<string, string> = {}) {
  try {
    const r = await fetch(url, {
      headers: {
        "user-agent": UA,
        accept: "application/json,text/plain,*/*",
        "accept-language": "en-US,en;q=0.9",
        referer: `https://new.abb.com/products/${PID}`,
        origin: "https://new.abb.com",
        ...extraHeaders
      }
    });
    const t = await r.text();
    const head = t.slice(0, 300);
    console.log(`${r.status.toString().padStart(3)} ${url}`);
    if (r.status < 400 && t.length > 50) {
      console.log(`     len=${t.length} body[0:200]=${head.replace(/\s+/g, " ").slice(0, 200)}`);
    }
  } catch (e) {
    console.log(`ERR ${url}: ${(e as Error).message}`);
  }
}

async function main() {
  const candidates = [
    // Likely public APIs that the JS widget hits internally.
    `https://library.abb.com/api/search/v1.0/library?productid=${PID}&languagecode=en&countrycode=*`,
    `https://library.abb.com/api/search/v1.0/documents?productid=${PID}&languagecode=en&countrycode=*`,
    `https://library.abb.com/api/search/v1.0/documents?productid=${PID}`,
    `https://search.abb.com/library/api/search/v1.0/library?productid=${PID}&languagecode=en&countrycode=*`,
    `https://search.abb.com/library/api/search/v1.0/documents?productid=${PID}`,
    `https://search.abb.com/library/Search.aspx?q=${PID}&format=json`,
    `https://search-ext.abb.com/library/api/search/v1.0/library?productid=${PID}&languagecode=en&countrycode=*`,
    `https://search-ext.abb.com/library/api/search/v1.0/documents?productid=${PID}`,
    // The "abbDsContainer" widget probably hits ds.library.abb.com
    `https://ds.library.abb.com/api/search/v1.0/documents?productid=${PID}&languagecode=en&countrycode=*`,
    `https://ds.library.abb.com/api/v1.0/library?productid=${PID}`,
    // Other plausible endpoints from the AOT AEM site
    `https://new.abb.com/api/abb-library/documents?productId=${PID}&languageCode=en&countryCode=*&clientCode=aotaem`,
    `https://new.abb.com/api/abb-library?productId=${PID}`,
    // PIS detail API for non-PIS pages
    `https://new.abb.com/api/PisProductApi?productId=${PID}&lang=en`,
    `https://new.abb.com/api/ProductDetail?productId=${PID}`,
    `https://new.abb.com/api/aot/products/${PID}?lang=en`,
    `https://new.abb.com/api/aot/products/${PID}`
  ];
  for (const url of candidates) await probe(url);
}

main().catch(console.error);
