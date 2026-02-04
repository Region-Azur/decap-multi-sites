const { createAppAuth } = require("@octokit/auth-app");
const { Octokit } = require("@octokit/rest");

const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const GITHUB_APP_INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID;
const GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY;
const GITHUB_APP_PRIVATE_KEY_BASE64 = process.env.GITHUB_APP_PRIVATE_KEY_BASE64 === "true";

function normalizePrivateKey(key) {
    if (!key) return "";
    let cleanKey = key;
    if (!cleanKey.includes("-----BEGIN RSA PRIVATE KEY-----")) {
        cleanKey = `-----BEGIN RSA PRIVATE KEY-----\n${cleanKey}\n-----END RSA PRIVATE KEY-----`;
    }
    return cleanKey.replace(/\\n/g, "\n");
}

async function getOctokit() {
    const privateKey = GITHUB_APP_PRIVATE_KEY_BASE64
        ? Buffer.from(GITHUB_APP_PRIVATE_KEY, "base64").toString("utf-8")
        : normalizePrivateKey(GITHUB_APP_PRIVATE_KEY);

    return new Octokit({
        authStrategy: createAppAuth,
        auth: {
            appId: GITHUB_APP_ID,
            privateKey: privateKey,
            installationId: GITHUB_APP_INSTALLATION_ID,
        },
    });
}

async function debugRepo() {
    // Hardocded repo and branch based on DB "region-azur/kursseite-26-BS-WS-2"
    const owner = "region-azur";
    const repo = "kursseite-26-BS-WS-2";
    const branch = "main"; // Assuming main

    console.log(`\n--- DEBUGGING REPO: ${owner}/${repo} (${branch}) ---\n`);

    try {
        const octokit = await getOctokit();

        // 1. Get Root Tree
        console.log(`Fetching ROOT tree for ${branch}...`);
        const { data: rootTree } = await octokit.git.getTree({
            owner,
            repo,
            tree_sha: branch,
            recursive: 1
        });

        console.log("\nFULL File List (Recursive):");
        rootTree.tree.forEach(item => {
            console.log(` - ${item.path} [${item.type}]`);
        });

        // 2. Check for 'content' specifically
        console.log("\n--- Analysis ---");
        const contentItems = rootTree.tree.filter(i => i.path.startsWith("content"));
        if (contentItems.length === 0) {
            console.log("CRITICAL: No items found starting with 'content/'!");
        } else {
            console.log(`Found ${contentItems.length} items in/under 'content':`);
            contentItems.forEach(i => console.log(`   ${i.path}`));
        }

    } catch (err) {
        console.error("\nERROR:", err.message);
        if (err.status === 404) {
            console.error("Repo or Branch not found!");
        }
    }
}

debugRepo();
