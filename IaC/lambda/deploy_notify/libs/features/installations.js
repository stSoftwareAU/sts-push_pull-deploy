
function listInstallations() {
  this.checkJWT();

  return this.getData({path:`/app/installations`}).then(response => {
    return response.data;
  });
}

function getInstallation({installation_id}) {
  this.checkJWT();

  if( installation_id >0){
    return this.getData({path:`/app/installations/${installation_id}`}).then(response => {
      return response.data;
    });
  }
  else{
    throw `installation_id must be a positive integer was: ${installation_id}`;
  }
}

function createAccessToken({installation_id}) {
  this.checkJWT();

  if( installation_id >0){
    return this.postData({path:`/app/installations/${installation_id}/access_tokens`}).then(response => {
      return response.data;
    });
  }
  else{
    throw `installation_id must be a positive integer was: ${installation_id}`;
  }
}

module.exports = {
  listInstallations: listInstallations,
  getInstallation: getInstallation,
  createAccessToken: createAccessToken
};
