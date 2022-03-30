

function createCheck({owner, repository, name, head_sha,details_url,conclusion}) {
  this.checkTOKEN();
  
  return this.postData({path:`/repos/${owner}/${repository}/check-runs`, data:{
    name, head_sha,details_url,conclusion
  }}).then(response => {
    return response.data;
  });
}

module.exports = {
  createCheck: createCheck
};
