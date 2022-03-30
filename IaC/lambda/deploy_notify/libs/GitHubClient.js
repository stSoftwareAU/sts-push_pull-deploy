/**
 * GitHubClient
 *
 * Dependencies: node-fetch https://github.com/bitinn/node-fetch
 *
 */
const fetch = require('node-fetch');

class HttpException extends Error {
  constructor({message, status, statusText, url}) {
    super(message);
    this.status = status;
    this.statusText = statusText;
    this.url = url;
  }
}

class GitHubClient {
  constructor({baseUri, token, jwt, debug=false}, ...features) {
    this.baseUri = baseUri;
    this.debug=debug;
    if( jwt != null){
      this.authType="JWT";
      this.credentials = "Bearer " + jwt;
    } else if( token != null && token.length > 0 ){
      this.authType="TOKEN";
      this.credentials = "token " + token;
    }
    else {
      this.authType="NONE";
      this.credentials = null;
    }
    this.headers = {
      "Content-Type": "application/json",
      "Accept": "application/vnd.github.v3.full+json",
      "Authorization": this.credentials
    };
    
    return Object.assign(this, ...features);
  }

  callGitHubAPI({method, path, data}) {
    let _response = {};
    return fetch(this.baseUri + path, {
      method: method,
      headers: this.headers,
      body: data!==null ? JSON.stringify(data) : null
    })
    .then(response => {
      _response = response;
      // if response is ok transform response.text to json object
      // else throw error
      if (response.ok) {
        return response.json()
      } else {
        throw new HttpException({
          message: `HttpException[${method}]`,
          status:response.status,
          statusText:response.statusText,
          url: response.url
        });
      }
    })
    .then(jsonData => {
      _response.data = jsonData;
      return _response;
    })

  }

  getData({path}) {
    if( this.debug){
      console.info( "GET: " + path);
    }
    return this.callGitHubAPI({method:'GET', path, data:null});
  }

  deleteData({path}) {
    if( this.debug){
      console.info( "DELETE: " + path);
    }
    return this.callGitHubAPI({method:'DELETE', path, data:null});
  }

  postData({path, data}) {
    if( this.debug){
      console.info( "POST: " + path, JSON.stringify(data, null, 2));
    }
    return this.callGitHubAPI({method:'POST', path, data});
  }

  putData({path, data}) {
    if( this.debug){
      console.info( "PUT: " + path, JSON.stringify(data, null, 2));
    }
    return this.callGitHubAPI({method:'PUT', path, data});
  }

  checkJWT(){
    if( this.authType != "JWT"){
      throw `Must use JWT authorization was: ${this.authType}`
    }
  }

  checkTOKEN(){
    if( this.authType != "TOKEN"){
      throw `Must use TOKEN authorization was: ${this.authType}`
    }
  }
}

module.exports = {
  GitHubClient: GitHubClient
};