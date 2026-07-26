#!/usr/bin/env node
/**
 * @fileoverview YouCom Provider Example - Demonstrates You.com integration with AgentOS
 *
 * This example shows how to use the YouCom provider for web search and news search.
 *
 * Usage:
 *   node examples/youcom-search-example.mjs
 *
 * Environment variables:
 *   YDC_API_KEY - You.com API key
 *   YOUCOM_API_KEY - Legacy fallback env var
 */

import { YouComProvider } from '@framers/agentos';

function printConfigurationExamples() {
  console.log('\n📚 Configuration Examples:\n');

  console.log('1. Environment-based setup:');
  console.log('   export YDC_API_KEY="your-api-key-here"');
  console.log('   # or export YOUCOM_API_KEY="your-api-key-here"\n');

  console.log('2. Explicit initialization:');
  console.log(`   const provider = new YouComProvider();
   await provider.initialize({
     apiKey: process.env.YDC_API_KEY ?? process.env.YOUCOM_API_KEY,
   });\n`);
}

async function runYouComExample() {
  console.log('🔍 YouCom Provider Example - Search with AgentOS\n');

  const provider = new YouComProvider();
  await provider.initialize({
    apiKey: process.env.YDC_API_KEY ?? process.env.YOUCOM_API_KEY,
    debug: true,
  });

  const webQuery = 'What are the latest developments in AI agent frameworks?';
  console.log(`\n📋 Web query: ${webQuery}`);
  const webResults = await provider.search(webQuery, { count: 5, type: 'web' });

  for (const [index, result] of (webResults.web ?? []).entries()) {
    console.log(`${index + 1}. ${result.title}`);
    console.log(`   ${result.url}`);
    console.log(`   ${result.description}`);
    if (result.snippets[0]) {
      console.log(`   ${result.snippets[0]}`);
    }
  }

  const newsQuery = 'TypeScript 5.7 release';
  console.log(`\n📰 News query: ${newsQuery}`);
  const newsResults = await provider.search(newsQuery, {
    count: 3,
    type: 'news',
    freshness: 'week',
  });

  for (const [index, result] of (newsResults.news ?? []).entries()) {
    console.log(`${index + 1}. ${result.title}`);
    console.log(`   ${result.url}`);
    console.log(`   ${result.description}`);
    if (result.published_at) {
      console.log(`   published: ${result.published_at}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  printConfigurationExamples();
  runYouComExample().catch((error) => {
    console.error('❌ YouCom example failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
