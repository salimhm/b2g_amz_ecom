import axios from 'axios';
import fs from 'fs';
import amazonScraper, { products } from 'amazon-buddy';
import redis from 'redis';
import pLimit from 'p-limit';
import { sign } from 'crypto';
import { Parser } from 'json2csv';
import { get } from 'http';
import UserAgent from 'user-agents';
import dotenv from 'dotenv';
dotenv.config();

const groqApiKey = process.env.GROQ_API_KEY;

const limit = pLimit(1);
const userAgent = new UserAgent().toString();

// Create a Redis client
// const redisClient = redis.createClient({
//     url: process.env.REDIS_URL || 'redis://localhost:6379'
// });

// redisClient.on('error', (err) => console.log('Redis Client Error', err));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
    try {
        const data = await fs.promises.readFile('amz-keywords.csv', 'utf-8');
        const lines = data.split('\r\n').filter(line => line.trim() !== '');

        const promises = lines.map((line, index) => {
            const [keyword, category] = line.trim().split(',');

            return limit(async () => {
                try {
                    console.log(`⌛ Starting scrape for: "${keyword}"`);
                    const products = await fetchAmzProducts(keyword);

                    // Log each product individually
                    // products.forEach(async (product, i) => {
                    // console.log(`\n✅ Product ${i + 1} for "${keyword}":`);
                    // console.log(`   Title: ${product.title}`);
                    // console.log(`   Price: ${product.price.current_price}`);
                    // console.log(`   Rating: ${product.reviews.rating}`);
                    // console.log(product);
                    // });
                    console.log(`-----------Found ${products.length} products for ${keyword}-----------`);

                    // for (const product of products) {
                    //     let asin = product.asin;
                    //     console.log(asin);

                    //     const result = await getProductByAsin(asin);
                    //     exportToCSV(result);
                    //     return;
                    // }

                    let productsDetails = await Promise.all(products.map(product => {
                        return getProductByAsin(product.asin);
                    }));

                    productsDetails = productsDetails.filter(product =>
                        product && product.title !== ''
                    );
                    console.log(`-----------Found ${productsDetails.length} products details for ${keyword}-----------`);
                    // console.log(productsDetails);

                    if (productsDetails.length === 0) {
                        console.log(`⚠️ No products found for "${keyword}"`);
                    } else {
                        console.log(`-----------Found ${productsDetails.length} products details-----------`);
                        try {
                            console.log(`-----------Exporting ${productsDetails.length} products details to CSV-----------`);
                            await exportToCSV(productsDetails, category);
                            console.log(`\n✅ Completed scrape for: "${keyword}"`);
                        } catch (error) {
                            console.error(`❌ Failed to export products for "${keyword}": ${error.message}`);
                        }
                    }

                    return {
                        keyword,
                        success: true,
                        data: products
                    };
                } catch (error) {
                    console.error(`❌ Failed for "${keyword}": ${error.message}`);
                    return {
                        keyword,
                        success: false,
                        error: error.message
                    };
                }
            });
        });

        await Promise.allSettled(promises);
        console.log('\n===== SCRAPING COMPLETE =====');
    } catch (err) {
        console.error('File read error:', err);
    }
})();


async function groqAssistant(content) {
    let messages;
    if (content.isTitle) {
        messages = [
            {
                role: 'system',
                content: `You are an SEO expert. Rewrite the product title to be keyword-rich, and around 50 - 70 characters. Do not include quotation marks or explanations. Return only the improved title.`
            },
            {
                role: 'user',
                content: content.title
            }
        ]
    } else if (content.isDescription) {
        messages = [
            {
                role: 'system',
                content: `You are an SEO copywriter. Rewrite the product description to be engaging, keyword-optimized, and suitable for an eCommerce store. Do not include headings, introductions, explanations, or lists. Only return the rewritten product description.`
            },
            {
                role: 'user',
                content: content.description
            }
        ]
    }

    let response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: 'llama-3.3-70b-versatile',
        messages: messages,
    }, {
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${groqApiKey}`,
            'User-Agent': userAgent,
        }
    })
    console.log();

    let res = response.data.choices[0]?.message?.content;
    console.log('========>>> ', res);
    return res;
}


async function fetchAmzProducts(keyword, proxyEndpoint, maxRetries = 10) {
    let attempts = 0;
    while (attempts < maxRetries) {
        try {
            const products = await amazonScraper.products({
                keyword: keyword,
                randomUa: true,
                timeout: 2000,
                number: 50,
                // proxy: proxyEndpoint
            });
            return products.result;
        } catch (e) {
            attempts++;
            console.error(`Attempt ${attempts} failed for keyword "${keyword}":`, e.message.slice(0, 10));
            if (attempts >= maxRetries) {
                throw new Error(`Max retries reached for keyword "${keyword}": ${e.message}`);
            }
        }
    }
}

async function getProductByAsin(asin, proxyEndpoint, maxRetries = 10) {
    let attempts = 0;
    while (attempts < maxRetries) {
        try {
            const product = await amazonScraper.asin({
                asin: asin,
                randomUa: true,
                // timeout: 2000,
                // proxy: proxyEndpoint
            });
            if (product.result[0].title === '') {
                throw new Error('Failed to fetch product details for ASIN: ' + asin);
            }
            console.log(`Product details for ASIN "${asin}":`, product.result[0].title);

            return product.result;
        } catch (e) {
            attempts++;
            console.error(`Attempt ${attempts} failed for ASIN "${asin}":`, e.message);
            if (attempts >= maxRetries) {
                throw new Error(`Max retries reached for ASIN "${asin}": ${e.message}`);
            }
        }
    }
}

const groqLimit = pLimit(1);

async function safeGroqRequest(callback) {
    const result = await groqLimit(async () => {
        await sleep(2000); // 1 request every 2 seconds
        return callback();
    });
    return result;
}

async function exportToCSV(products, category, filename = 'wc-products.csv') {
    products = [].concat(...products); // Flatten the array if it's nested

    products.forEach(p => {
        console.log(`Product: ${p.asin}`);
        if (!p.description) {
            p.description = p.feature_bullets;
        }
        console.log(`Description: ${p.description}`);
    });

    const formatted = [];

    const results = await Promise.allSettled(products.map(async p => {
        try {
            const title = await safeGroqRequest(() => groqAssistant({ isTitle: true, title: p.title }));
            const description = await safeGroqRequest(() => groqAssistant({ isDescription: true, description: p.description }));

            formatted.push({
                Name: title,
                Description: description,
                'Short description': p.feature_bullets ? p.feature_bullets.join('\n') : '',
                'Regular price': parseFloat(p.price?.current_price) + 20, // Add 20 to the price
                Images: p.images ? p.images.join(',') : '',
                'Meta:asin': p.asin,
                Category: category
            });
        } catch (err) {
            console.error(`❌ Failed processing product ${p.asin}:`, err.message || err);
        }
    }));

    if (formatted.length === 0) {
        console.warn('⚠️ No formatted products available to export.');
        return;
    }

    try {
        const parser = new Parser();
        const csv = parser.parse(formatted);

        fs.appendFile(filename, csv + '\n', err => {
            if (err) {
                console.error('❌ Error writing to CSV file:', err);
            } else {
                console.log('✅ CSV file updated successfully.');
            }
        });

        console.log(`✅ CSV exported to ${filename}`);
    } catch (e) {
        console.error('❌ Error converting to CSV:', e.message || e);
    }
}
