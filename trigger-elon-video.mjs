/**
 * Trigger a test video generation about Elon Musk
 * This calls the server's internal API directly via HTTP
 */

// Use the tRPC batch endpoint with admin credentials via cookie
// Since we can't authenticate via cookie in a script, we'll call the internal function directly
// by inserting a video record and triggering the pipeline via a direct HTTP call to the server

const SERVER_URL = 'http://localhost:3000';

async function main() {
  console.log('Triggering Elon Musk video generation...');
  
  // Call the admin.generateVideo endpoint
  // We need to be authenticated — let's use the internal trigger endpoint if it exists
  // Otherwise, use a direct DB insert + pipeline call
  
  const response = await fetch(`${SERVER_URL}/api/trpc/admin.generateVideo`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Include a cookie header if we have one
    },
    body: JSON.stringify({
      json: {
        prompt: 'Elon Musk: The Visionary Behind Tesla, SpaceX, and the Future of Humanity',
        videoLength: '5-8',
        videoType: 'documentary',
      }
    }),
  });
  
  const text = await response.text();
  console.log('Status:', response.status);
  console.log('Response:', text.substring(0, 1000));
}

main().catch(console.error);
