#!/usr/bin/env node

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const _ = require('lodash');
const { version } = require('./package.json'); // Always use self version for docker image

const BASE_VERSION = 'toolchain';
const DOCKER_HUB_NAME = 'anacierdem/libdragon';
const UPDATE_LATEST = true;

// Default options
const options = {
  PROJECT_NAME: process.env.npm_package_name || 'libdragon', // Use active package name when available
  BYTE_SWAP: false,
  MOUNT_PATH: process.cwd(),
  IS_CI: process.env.CI === 'true',
};

// Use base version if building self in CI, actual version o/w
// When self building, the new version does not exist yet
options.SELF_BUILD =
  options.PROJECT_NAME === 'libdragon' ? options.IS_CI : false;

function runCommand(cmd) {
  return new Promise((resolve, reject) => {
    const command = exec(cmd, {}, (err, stdout) => {
      if (err === null) {
        resolve(stdout);
      } else {
        reject(err);
      }
    });

    command.stdout.on('data', function (data) {
      console.log(data.toString());
    });

    command.stderr.on('data', function (data) {
      console.error(data.toString());
    });
  });
}

async function startToolchain(forceLatest = false) {
  // Do not try to run docker if already in container
  if (process.env.IS_DOCKER === 'true') {
    return;
  }

  const containerID = await runCommand(
    'docker container ls -qa -f name=^/' + options.PROJECT_NAME + '$'
  );

  if (containerID) {
    await runCommand('docker container rm -f ' + containerID);
  }

  await runCommand(
    'docker run --name=' +
      options.PROJECT_NAME +
      (options.BYTE_SWAP ? ' -e N64_BYTE_SWAP=true' : '') +
      ' -e IS_DOCKER=true' +
      ' -d --mount type=bind,source="' +
      options.MOUNT_PATH +
      '",target=/' +
      options.PROJECT_NAME +
      ' -w="/' +
      options.PROJECT_NAME +
      '" ' +
      DOCKER_HUB_NAME +
      ':' +
      (!forceLatest && options.SELF_BUILD ? BASE_VERSION : version) +
      ' tail -f /dev/null'
  );
}

async function make(param) {
  // Do not try to run docker if already in container
  if (process.env.IS_DOCKER === 'true') {
    await runCommand('make ' + param);
    return;
  }
  await runCommand('docker start ' + options.PROJECT_NAME);
  await runCommand('docker exec ' + options.PROJECT_NAME + ' make ' + param);
}

async function download() {
  // Do not try to run docker if already in container
  if (process.env.IS_DOCKER === 'true') {
    return;
  }
  await runCommand('docker pull ' + DOCKER_HUB_NAME + ':' + BASE_VERSION);

  // Use only base version on CI
  if (!options.SELF_BUILD) {
    await runCommand('docker pull ' + DOCKER_HUB_NAME + ':' + version);
  }
}

async function stop() {
  // Do not try to run docker if already in container
  if (process.env.IS_DOCKER === 'true') {
    return;
  }
  const list = await runCommand(
    'docker ps -a -q -f name=^/' + options.PROJECT_NAME + '$'
  );
  if (list) {
    await runCommand('docker rm -f ' + options.PROJECT_NAME);
  }
}

async function buildDragon() {
  await runCommand(
    'docker build' +
      ' --build-arg DOCKER_HUB_NAME=' +
      DOCKER_HUB_NAME +
      ' --build-arg BASE_VERSION=' +
      BASE_VERSION +
      ' -t ' +
      DOCKER_HUB_NAME +
      ':' +
      version +
      ' -f ./dragon.Dockerfile ./'
  );
  // Start freshly built image
  await startToolchain(true);
}

const availableActions = {
  start: startToolchain,
  download: download,
  init: async function initialize() {
    // Do not try to run docker if already in container
    if (process.env.IS_DOCKER === 'true') {
      return;
    }

    // Build toolchain
    await runCommand(
      'docker build -t ' + DOCKER_HUB_NAME + ':' + BASE_VERSION + ' ./'
    );

    // Build and install libdragon
    await buildDragon();
  },
  install: async function install() {
    await download();
    await startToolchain(true);

    const { dependencies } = require(path.join(
      process.cwd() + '/package.json'
    ));

    const { devDependencies } = require(path.join(
      process.cwd() + '/package.json'
    ));

    const deps = await Promise.all(
      Object.keys({
        ...dependencies,
        ...devDependencies,
      })
        .filter((dep) => dep !== 'libdragon')
        .map(async (dep) => {
          const npmPath = await runCommand(
            'npm ls ' + dep + ' --parseable=true'
          );
          return {
            name: dep,
            paths: _.uniq(npmPath.split('\n').filter((f) => f)),
          };
        })
    );

    await Promise.all(
      deps.map(({ paths }) => {
        if (paths.length > 1) {
          return Promise.reject(
            'Using same dependency with different versions is not supported!'
          );
        }
        return new Promise((resolve, reject) => {
          fs.access(path.join(paths[0], 'Makefile'), fs.F_OK, async (e) => {
            if (e) {
              // File does not exist - skip
              resolve();
              return;
            }

            try {
              const relativePath = path
                .relative(options.MOUNT_PATH, paths[0])
                .replace(new RegExp('\\' + path.sep), path.posix.sep);
              const containerPath = path.posix.join(
                '/',
                options.PROJECT_NAME,
                relativePath,
                '/'
              );
              const makePath = path.posix.join(containerPath, 'Makefile');

              // Do not try to run docker if already in container
              if (process.env.IS_DOCKER === 'true') {
                await runCommand(
                  '[ -f ' +
                    makePath +
                    ' ] &&  make -C ' +
                    containerPath +
                    ' && make -C ' +
                    containerPath +
                    ' install'
                );
              } else {
                await runCommand(
                  'docker exec ' +
                    options.PROJECT_NAME +
                    ' /bin/bash -c "[ -f ' +
                    makePath +
                    ' ] &&  make -C ' +
                    containerPath +
                    ' && make -C ' +
                    containerPath +
                    ' install"'
                );
              }
              resolve();
            } catch (e) {
              reject(e);
            }
          });
        });
      })
    );
  },
  make: make,
  stop: stop,
  buildDragon: buildDragon,
  // This requires docker login
  update: async function update() {
    // Do not try to run docker if already in container
    if (process.env.IS_DOCKER === 'true') {
      return;
    }
    await stop();
    // We assume buildDragon was run.
    await runCommand('docker push ' + DOCKER_HUB_NAME + ':' + version);

    if (UPDATE_LATEST) {
      await runCommand(
        'docker tag ' +
          DOCKER_HUB_NAME +
          ':' +
          version +
          ' ' +
          DOCKER_HUB_NAME +
          ':latest'
      );
      await runCommand('docker push ' + DOCKER_HUB_NAME + ':latest');
    }
  },
};

process.argv.forEach(function (val, index) {
  if (index < 1) {
    return;
  }

  if (val.indexOf('--mount-path=') === 0) {
    options.MOUNT_PATH = path.join(
      process.cwd(),
      val.split('--mount-path=')[1]
    );
    return;
  }

  if (val === '--byte-swap') {
    options.BYTE_SWAP = true;
    return;
  }

  if (val === '--help') {
    console.log('Available actions:');
    Object.keys(availableActions).forEach((val) => {
      console.log(val);
    });
    process.exit(0);
    return;
  }

  const functionToRun = availableActions[val];
  if (typeof functionToRun === 'function') {
    const params = process.argv.slice(index + 1);
    const param = params.join(' ');

    functionToRun(param)
      .then((r) => {
        process.exit(0);
      })
      .catch((e) => {
        process.exit(1);
      });
  }
});
