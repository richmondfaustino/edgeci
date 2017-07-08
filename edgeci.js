var fs = require('fs');
var unzip = require('unzip');
var rimraf = require('rimraf');
var zipfolder = require('zip-folder');
var request = require("request");
var ArgumentParser = require("argparse").ArgumentParser;

var baseURL = 'https://api.enterprise.apigee.com/v1/organizations/';
var data = {};
var args = {};

function parseArgs() {
  var parser = new ArgumentParser({
    version: '0.0.1',
    addHelp: true,
    description: 'edgeci command line tool'
  });
  parser.addArgument(
    [ '-q', '--quite' ],
    { action: 'storeTrue', help: 'no console logs' }
  );
  parser.addArgument(
    [ '-V', '--verbose' ],
    { action: 'storeTrue', help: 'verbose logging to console' }
  );
  var subparsers = parser.addSubparsers({ title: 'command', dest: "command" });
  var pullCommand = subparsers.addParser('pull', { addHelp: true, help: "pull help" });
  addPullArgs(pullCommand);
  var pushCommand = subparsers.addParser('push', { addHelp: true, help: "push help" });
  addPushArgs(pushCommand);
  args = parser.parseArgs();
  args.username = process.env.EDGE_USERNAME;
  args.password = process.env.EDGE_PASSWORD;
}

function addPullArgs(pullCommand) {
  pullCommand.addArgument(
    [ '-o', '--org' ],
    { action: 'store', required: true, help: 'name of Edge org to pull proxy from' }
  );
  pullCommand.addArgument(
    [ '-p', '--proxy' ],
    { action: 'store', required: true, nargs: '*', help: 'proxies to pull, space separated names' }
  );
  pullCommand.addArgument(
    [ '-d', '--destination' ],
    { action: 'store', defaultValue: ".", help: 'destination dir to download proxy files' }
  );
  pullCommand.addArgument(
    [ '-c', '--continuous' ],
    { action: 'storeTrue', help: 'continuously check for updates' }
  );
  pullCommand.addArgument(
    [ '-i', '--interval' ],
    { action: 'store', type: 'int', defaultValue: 30, help: 'interval to check for updates in seconds' }
  );
}

function addPushArgs(pullCommand) {
  pullCommand.addArgument(
    [ '-o', '--org' ],
    { action: 'store', required: true, help: 'name of Edge org to push proxy to' }
  );
  pullCommand.addArgument(
    [ '-p', '--proxy' ],
    { action: 'store', required: true, nargs: '*', help: 'proxies to push, space separated names' }
  );
  pullCommand.addArgument(
    [ '-s', '--source' ],
    { action: 'store', defaultValue: ".", help: 'source dir to pick proxy files to upload' }
  );
  pullCommand.addArgument(
    [ '-u', '--update' ],
    { action: 'storeTrue', help: 'update current revision' }
  );
  pullCommand.addArgument(
    [ '-e', '--env' ],
    { action: 'store', help: 'deploy to env specified' }
  );
}

function execute() {
  parseArgs();
  runCommand();
}

function runCommand() {
  if (args.command === "pull") {
    if (args.continuous) {
      setInterval(pull, (args.interval * 1000));
    } else {
      pull();
    }
  } else if (args.command === "push") {
    push();
  } else {
    console.log("Unknown command " + args.command);
  }
}

function pullWithArgs(username, password, org, proxies, destination, continuous, interval) {
  args = {};
  args.org = org;
  args.proxy = proxies;
  args.destination = destination;
  args.continuous = continuous;
  args.interval = interval;
  args.username = username;
  args.password = password;
  pull();
}

function pull() {
  if (args.proxy[0] === "all") {
    getProxyList(args.org, pullProxies);
  } else {
    pullProxies();
  }
}

function pushWithArgs(username, password, org, proxies, source, update, env) {
  args = {};
  args.org = org;
  args.proxy = proxies;
  args.source = source;
  args.update = update;
  args.env = env;
  args.username = username;
  args.password = password;
  pull();
}

function push() {
  if (args.proxy[0] === "all") {
    args.proxy = getProxySourceDirs();
  }
  pushProxies();
}

function pullProxies() {
  args.proxy.forEach(function(aProxy) {
    verboseLog("Checking proxy: " + aProxy);
    getProxyToPull(args.org, aProxy);
  });
}

function pushProxies() {
  args.proxy.forEach(function(aProxy) {
    verboseLog("Checking proxy: " + aProxy);
    zipProxy(aProxy);
    getProxyToPush(args.org, aProxy);
  });
}

function getMaxRevision(revisions) {
  return revisions.reduce(function(a, b) {
      return Math.max(a, b);
  });
}

function getProxySourceDirs() {
  return fs.readdirSync(args.source).filter(
    file => fs.statSync(args.source + "/" + file).isDirectory()
  );
}

function getProxyToPull(orgName, proxyName) {
	request(apiOptions(orgName, proxyName), function(error, response, body) {
	  if (!error && response.statusCode == 200) {
      var content = JSON.parse(body);
      var lastRevision = getMaxRevision(content.revision);
      var lastModified = content.metaData.lastModifiedAt;
      if (!data[proxyName] || (data[proxyName].lastModified < lastModified)) {
        data[proxyName] = {
          proxyName: proxyName,
          lastRevision: lastRevision,
          lastModified: lastModified
        }
        defaultLog("Exporting proxy " + proxyName + " revision " + lastRevision);
        exportProxy(orgName, proxyName, lastRevision);
      }
	  } else {
	  	logError('getAPI: ', error, response, body);
	  }
	});
}

function getProxyToPush(orgName, proxyName) {
  request(apiOptions(orgName, proxyName), function(error, response, body) {
    if (!error && response.statusCode == 200) {
      var content = JSON.parse(body);
      var lastRevision = getMaxRevision(content.revision);
      if (args.update) {
        defaultLog("Updating proxy " + proxyName + " revision " + lastRevision);
        updateProxy(orgName, proxyName, lastRevision);
      } else {
        newRevision = lastRevision + 1;
        defaultLog("Importing proxy " + proxyName + " new revision " + newRevision);
        importProxy(orgName, proxyName, newRevision);
      }
    } else {
      defaultLog("Importing new proxy " + proxyName);
      importProxy(orgName, proxyName, 1);
    }
  });
}

function getProxyList(orgName, callback) {
  defaultLog("Getting list of proxies");
  request(listOptions(orgName), function(error, response, body) {
    if (!error && response.statusCode == 200) {
      var proxies = JSON.parse(body);
      defaultLog("Proxies: " + proxies);
      args.proxy = proxies;
      callback();
    } else {
      logError('listProxies: ', error, response, body);
    }
  });
}

function exportProxy(orgName, proxyName, revision) {
  rimraf.sync(getProxyDestinationPath(proxyName));
  request(exportOptions(orgName, proxyName, revision), function(error, response, body) {
    if (!error && response.statusCode == 200) {
      defaultLog("Done exporting proxy " + proxyName + " revision " + revision);
    } else {
      logError('exportProxy: ', error, response, body);
    }
  })
  .pipe(unzip.Extract({ path: getProxyDestinationPath(proxyName) }));
}

function zipProxy(proxyName) {
  rimraf.sync(getProxyZipPath(proxyName));
  zipfolder(getProxySourcePath(proxyName), getProxyZipPath(proxyName), function(err) {
    if (err) {
      console.log("Error zipping " + proxyName);
    } else {
      console.log("Done zipping proxy " + proxyName);
    }
  });
}

function importProxy(orgName, proxyName, revision) {
  request(importOptions(orgName, proxyName), function(error, response, body) {
    if (!error && response.statusCode == 201) {
      defaultLog("Done importing proxy " + proxyName);
      deployProxy(orgName, proxyName, revision);
    } else {
      logError('importProxy: ', error, response, body);
    }
  });
}

function updateProxy(orgName, proxyName, revision) {
  request(updateOptions(orgName, proxyName, revision), function(error, response, body) {
    if (!error && response.statusCode == 200) {
      defaultLog("Done updating proxy " + proxyName + " revision " + revision);
    } else {
      logError('updateProxy: ', error, response, body);
    }
  });
}

function deployProxy(orgName, proxyName, revision) {
  if (isEmpty(args.env)) return;
  defaultLog("Deploying proxy " + proxyName + " revision " + revision + " to env " + args.env);
  request(deployOptions(orgName, proxyName, revision, args.env), function(error, response, body) {
    if (!error && response.statusCode == 200) {
      defaultLog("Done deploying proxy " + proxyName + " revision " + revision + " to env " + args.env);
    } else {
      logError('deployProxy: ', error, response, body);
    }
  });
}

function listOptions(orgName) {
  return {
    url: baseURL +  orgName + "/apis",
    method: 'GET',
    auth: {
      user: args.username,
      pass: args.password
    }
  };
}

function apiOptions(orgName, proxyName) {
  return {
    url: baseURL +  orgName + "/apis/" + proxyName,
    method: 'GET',
    auth: {
      user: args.username,
      pass: args.password
    }
  };
}

function exportOptions(orgName, proxyName, revision) {
  return {
    url: baseURL +  orgName + "/apis/" + proxyName + "/revisions/" + revision,
    method: 'GET',
    auth: {
      user: args.username,
      pass: args.password
    },
    qs: {
      format: "bundle"
    }
  };
}

function importOptions(orgName, proxyName) {
  return {
    url: baseURL +  orgName + "/apis",
    method: 'POST',
    auth: {
      user: args.username,
      pass: args.password
    },
    qs: {
      action: "import",
      name: proxyName,
      validate: true
    },
    formData: {
      file: fs.createReadStream(getProxyZipPath(proxyName))
    }
  };
}

function updateOptions(orgName, proxyName, revision) {
  return {
    url: baseURL +  orgName + "/apis/" + proxyName + "/revisions/" + revision,
    method: 'POST',
    auth: {
      user: args.username,
      pass: args.password
    },
    qs: {
      validate: true
    },
    formData: {
      file: fs.createReadStream(getProxyZipPath(proxyName))
    }
  };
}

function deployOptions(orgName, proxyName, revision, env) {
  return {
    url: baseURL +  orgName + "/environments/" + env + "/apis/" + proxyName + "/revisions/" + revision + "/deployments",
    method: 'POST',
    auth: {
      user: args.username,
      pass: args.password
    },
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    qs: {
      override: "true"
    }
  };
}

function getProxyDestinationPath(proxyName) {
  return args.destination + "/" + proxyName;
}

function getProxySourcePath(proxyName) {
  return args.source + "/" + proxyName;
}

function getProxyZipPath(proxyName) {
  return args.source + "/" + proxyName + ".zip";
}

function isEmpty(str) {
	return !str || (undefined === str) || ("" === str);
}

function defaultLog(msg) {
  if (!args.quite) {
    console.log(msg);
  }
}

function verboseLog(msg) {
  if (args.verbose) {
    console.log(msg);
  }
}

function logError(fnName, error, response, body) {
  console.log("Error while calling " + fnName);
  console.log('statusCode:', response && response.statusCode);
  console.log('error:', error);
  console.log('body:', body);
}


if (require.main === module) {
  execute();
} else {
  module.exports = {
    pull: pullWithArgs,
    push: pushWithArgs
  };
}