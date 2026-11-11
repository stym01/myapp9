const https = require('https');

class KeyManager {
  constructor() {
    this.userKey = null;
    this.apiKey = null;
    this.lastFetchTime = null;
    this.apiEndpoint = 'https://client-c-5.night-king.workers.dev/';
  }

  // Set the user key
  setUserKey(userKey) {
    this.userKey = userKey;
  }

  // Get the current user key
  getUserKey() {
    return this.userKey;
  }

  // Fetch API key from the endpoint
  async fetchApiKey() {
    if (!this.userKey) {
      throw new Error('User key not set');
    }

    return new Promise((resolve, reject) => {
      const url = `${this.apiEndpoint}?userkey=${encodeURIComponent(this.userKey)}`;
      
      https.get(url, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            // Handle HTTP status codes
            if (res.statusCode === 401) {
              reject(new Error('Invalid user key'));
              return;
            } else if (res.statusCode === 403) {
              reject(new Error('User key access denied'));
              return;
            } else if (res.statusCode === 404) {
              reject(new Error('Invalid user key'));
              return;
            } else if (res.statusCode !== 200) {
              reject(new Error(`Server error: ${res.statusCode}`));
              return;
            }
            
            const response = JSON.parse(data);
            
            if (response.apiKey) {
              this.apiKey = response.apiKey;
              this.lastFetchTime = Date.now();
              console.log('API key fetched successfully');
              resolve(this.apiKey);
            } else if (response.message && response.message.includes('expired')) {
              reject(new Error('User key expired'));
            } else {
              reject(new Error(response.message || 'Invalid user key'));
            }
          } catch (error) {
            reject(new Error('Invalid response from server'));
          }
        });
      }).on('error', (error) => {
        reject(new Error(`Network error: ${error.message}`));
      });
    });
  }

  // Get API key, refresh if needed
  async getApiKey() {
    if (!this.userKey) {
      throw new Error('User key not set');
    }

    // Always fetch fresh API key before each request
    try {
      await this.fetchApiKey();
      return this.apiKey;
    } catch (error) {
      console.error('Failed to fetch API key:', error.message);
      throw error;
    }
  }

  // Check if we have a valid user key
  hasUserKey() {
    return !!this.userKey;
  }

  // Clear all keys
  clearKeys() {
    this.userKey = null;
    this.apiKey = null;
    this.lastFetchTime = null;
  }
}

module.exports = KeyManager;
