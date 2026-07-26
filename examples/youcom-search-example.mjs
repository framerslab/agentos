#!/usr/bin/env node
/**
 * @fileoverview YouCom Provider Example - Demonstrates You.com integration with AgentOS
 * 
 * This example shows how to use AgentOS with the YouCom provider for web search capabilities.
 * The YouCom provider offers both keyless (free tier) and authenticated search access.
 * 
 * Usage:
 *   node examples/youcom-search-example.mjs
 *   
 * Environment variables:
 *   YDC_API_KEY - Optional You.com API key for authenticated access
 *   YOUCOM_API_KEY - Alternative env var (fallback for legacy setups)
 */

import { agent } from '@framers/agentos';

async function runYouComExample() {
  console.log('🔍 YouCom Provider Example - Web Search with AgentOS\n');

  try {
    // Create an agent using the YouCom provider
    const searchAgent = agent({
      provider: 'youcom',
      instructions: `You are a research assistant with access to current web information through You.com search.
      
When users ask questions that require current information, use your search capabilities to find relevant results.
Always cite your sources with URLs and provide a balanced view from multiple sources when possible.`,
      tools: ['search'], // YouCom provider exposes search as a core capability
      memory: { types: ['episodic'], working: { enabled: true } },
    });

    const session = searchAgent.session('youcom-demo');

    console.log('Creating agent session with YouCom provider...');
    
    // Example queries demonstrating different search capabilities
    const queries = [
      "What are the latest developments in AI agent frameworks?",
      "Find recent news about TypeScript 5.7 features",
      "Search for information about MCP (Model Context Protocol) adoption"
    ];

    for (const query of queries) {
      console.log(`\n📋 Query: ${query}`);
      console.log('🔄 Searching...\n');
      
      try {
        const response = await session.send(query);
        console.log(`📖 Response:\n${response}\n`);
        console.log('─'.repeat(80));
      } catch (error) {
        console.error(`❌ Error processing query: ${error.message}`);
        
        if (error.message.includes('rate limit')) {
          console.log('💡 Tip: Set YDC_API_KEY environment variable for higher search quotas');
        }
      }
    }

    // Demonstrate direct search API access
    console.log('\n🔧 Direct YouCom Search API Example:\n');
    
    const provider = searchAgent.provider; // Access the YouCom provider directly
    if (provider && typeof provider.search === 'function') {
      try {
        const searchResult = await provider.search('AgentOS framework features', { count: 3 });
        
        console.log('Direct search results:');
        if (searchResult.web) {
          searchResult.web.forEach((result, index) => {
            console.log(`${index + 1}. ${result.title}`);
            console.log(`   ${result.url}`);
            console.log(`   ${result.snippet}\n`);
          });
        }
      } catch (error) {
        console.log(`Direct search failed: ${error.message}`);
      }
    }

  } catch (error) {
    console.error('❌ Failed to initialize YouCom provider:', error.message);
    
    if (error.message.includes('not initialized')) {
      console.log('\n💡 Troubleshooting:');
      console.log('   - Make sure you have network connectivity');
      console.log('   - For higher quotas, set YDC_API_KEY environment variable');
      console.log('   - Check https://you.com/platform/api-keys for API keys');
    }
  }
}

// Configuration examples for different authentication modes
function printConfigurationExamples() {
  console.log('\n📚 Configuration Examples:\n');
  
  console.log('1. Keyless mode (100 free searches/day per IP):');
  console.log('   No configuration needed - just use provider: "youcom"\n');
  
  console.log('2. Authenticated mode (higher quotas):');
  console.log('   export YDC_API_KEY="your-api-key-here"');
  console.log('   # Get API keys at: https://you.com/platform/api-keys\n');
  
  console.log('3. Custom configuration:');
  console.log(`   const agent = agent({
     provider: 'youcom',
     providerConfig: {
       apiKey: 'your-key',
       debug: true
     }
   });\n`);
}

// Check if running directly vs imported
if (import.meta.url === `file://${process.argv[1]}`) {
  printConfigurationExamples();
  runYouComExample().catch(console.error);
}