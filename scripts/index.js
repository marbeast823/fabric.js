#!/usr/bin/env node
const fs = require('fs-extra');
const os = require('os');
const _ = require('lodash');
const path = require('path');
const cp = require('child_process');
const inquirer = require('inquirer');
const fuzzy = require('fuzzy');
const chalk = require('chalk');
const moment = require('moment');
const Checkbox = require('inquirer-checkbox-plus-prompt');
const commander = require('commander');
const killPort = require('kill-port');

// const rollup = require('rollup');
// const loadConfigFile = require('rollup/loadConfigFile');

const program = new commander.Command();

const { transform: transformFiles, listFiles } = require('./transform_files');


const wd = path.resolve(__dirname, '..');
const dumpsPath = path.resolve(wd, 'cli_output');
const CLI_CACHE = path.resolve(dumpsPath, 'cli_cache.json');
const websiteDir = path.resolve(wd, '../fabricjs.com');
if (!fs.existsSync(dumpsPath)) {
    fs.mkdirSync(dumpsPath);
}
const package = require(path.resolve(wd, 'package.json'));

function execGitCommand(cmd) {
    return cp.execSync(cmd, { cwd: wd }).toString()
        .replace(/\n/g, ',')
        .split(',')
        .map(value => value.trim())
        .filter(value => value.length > 0);
}

function getGitInfo(branchRef) {
    const branch = execGitCommand('git branch --show-current')[0];
    const tag = execGitCommand('git describe --tags')[0];
    const uncommittedChanges = execGitCommand('git status --porcelain').map(value => {
        const [type, path] = value.split(' ');
        return { type, path };
    });
    const changes = execGitCommand(`git diff ${branchRef} --name-only`);
    const userName = execGitCommand('git config user.name')[0];
    return {
        branch,
        tag,
        uncommittedChanges,
        changes,
        user: userName
    };
}

class ICheckbox extends Checkbox {
    constructor(questions, rl, answers) {
        super(questions, rl, answers);
        this.opt.source = this.opt.source.bind(this);
    }
    getCurrentValue() {
        const current = super.getCurrentValue();
        return current.concat(this.firstSourceLoading ? this.default : []);
    }
    onSpaceKey() {
        const choice = this.choices.getChoice(this.pointer);
        if (!choice) {
            return;
        }

        this.toggleChoice(choice);
        if (choice.value && !choice.value.file) {
            delete this.lastQuery;
            // Remove the choices from the checked values with the same type
            _.remove(this.value, v => v.type === choice.value.type && v.file);
            _.remove(this.checkedChoices, checkedChoice => {
                if (!checkedChoice.value.file) {
                    return false;
                }
                checkedChoice.checked = false;
                return checkedChoice.value.type === choice.value.type;
            });

            this.executeSource();
        }

        this.render();
    }
}
inquirer.registerPrompt('test-selection', ICheckbox);

// async function rollupBuild(options = {}, onComplete) {
//     const { options: buildOptions, warnings } = await loadConfigFile(path.resolve(__dirname, '..', 'rollup.config.js'), { format: 'es' });
//     warnings.flush();
//     if (options.output) {
//         buildOptions.output = [options.output];
//     }
//     if (options.watch) {
//         const watcher = rollup.watch(buildOptions);
//         watcher.on('END', () => {
//             onComplete && onComplete();
//         });
//         watcher.on('event', ({ result }) => {
//             if (result) {
//                 result.close();
//             }
//         });
//         process.on('beforeExit', () => watcher.close());
//     }
//     else {
//         for (const optionsObj of buildOptions) {
//             const bundle = await rollup.rollup(optionsObj);
//             await Promise.all(optionsObj.output.map(bundle.write));
//         }

//         onComplete && onComplete();
//     }
// }


function build(options = {}) {
    const args = ['rollup', '-c', options.watch ? '--watch' : ''];
    let minDest;
    if (options.output && !options.fast) {
        const { name, base, ...rest } = path.parse(path.resolve(options.output));
        minDest = path.format({ name: `${name}.min`, ...rest });
    }
    return cp.spawn(args.join(' '), {
        stdio: 'inherit',
        shell: true,
        cwd: wd,
        env: {
            ...process.env,
            MINIFY: Number(!options.fast),
            BUILD_INPUT: options.input,
            BUILD_OUTPUT: options.output,
            BUILD_MIN_OUTPUT: minDest
        },
    });
}

function startWebsite() {
    if (require(path.resolve(websiteDir, 'package.json')).name !== 'fabricjs.com') {
        console.log(chalk.red('Could not locate fabricjs.com directory'));
    }
    const args = ['run', 'start:dev'];

    //  WSL ubuntu
    // https://github.com/microsoft/WSL/issues/216
    // os.platform() === 'win32' && args.push('--', '--force_polling', '--livereload');
    if (os.platform() === 'win32') {
        console.log(chalk.green('Consider using ubuntu on WSL to run jekyll with the following options:'));
        console.log(chalk.yellow('-- force_polling --livereload'));
        console.log(chalk.gray('https://github.com/microsoft/WSL/issues/216'));
    }

    cp.spawn('npm', args, {
        stdio: 'inherit',
        cwd: websiteDir,
        shell: true,
    });
}

function watch(path, callback, debounce = 500) {
    fs.watch(path, { recursive: true }, _.debounce((type, location) => {
        try {
            callback(type, location);
        } catch (error) {
            console.error(error);
        }
    }, debounce, { trailing: true }));
}

function copy(from, to) {
    try {
        fs.copySync(from, to);
        const containingFolder = path.resolve(wd, '..');
        console.log(`copied ${path.relative(containingFolder, from)} to ${path.relative(containingFolder, to)}`);
    } catch (error) {
        console.error(error);
    }
}

const BUILD_SOURCE = ['src', 'lib', 'HEADER.js'];

function exportBuildToWebsite(options = {}) {
    _.defaultsDeep(options, { gestures: true });
    build({
        output: path.resolve(websiteDir, './lib/fabric.js'),
        fast: true,
        watch: options.watch
    });
    if (options.gestures) {
        build({
            exclude: ['accessors'],
            output: path.resolve(websiteDir, './lib/fabric_with_gestures.js'),
            fast: true,
            watch: options.watch
        });
    }
}

function exportAssetsToWebsite(options) {
    copy(path.resolve(wd, './package.json'), path.resolve(websiteDir, './lib/package.json'));
    BUILD_SOURCE.forEach(p => copy(path.resolve(wd, p), path.resolve(websiteDir, './build/files', p)));
    console.log(chalk.bold(`[${moment().format('HH:mm')}] exported assets to fabricjs.com`));
    options.watch && BUILD_SOURCE.forEach(p => {
        watch(path.resolve(wd, p), () => {
            copy(path.resolve(wd, p), path.resolve(websiteDir, './build/files', p));
            console.log(chalk.bold(`[${moment().format('HH:mm')}] exported ${p} to fabricjs.com`));
        });
    });
}

function exportTestsToWebsite(options) {
    const exportTests = () => {
        const paths = [
            './test/unit',
            './test/visual',
            './test/fixtures',
            './test/lib',
        ]
        paths.forEach(location => copy(path.resolve(wd, location), path.resolve(websiteDir, location)));
        console.log(chalk.bold(`[${moment().format('HH:mm')}] exported tests to fabricjs.com`));
    }
    exportTests();
    options.watch && watch(path.resolve(wd, './test'), exportTests);
}

function exportToWebsite(options) {
    if (!options.include || options.include.length === 0) {
        options.include = ['build', 'tests'];
    }
    options.include.forEach(x => {
        if (x === 'build') {
            exportBuildToWebsite(options);
            exportAssetsToWebsite(options);
        }
        else if (x === 'tests') {
            exportTestsToWebsite(options);
        }
    })
}


/**
 *
 * @param {'unit' | 'visual'} suite
 * @param {string[] | null} tests file paths
 * @param {{debug?:boolean,recreate?:boolean,verbose?:boolean,filter?:string}} [options]
 */
async function test(suite, tests, options = {}) {
    const port = options.port || suite === 'visual' ? 8081 : 8080;
    try {
        await killPort(port);
    } catch (error) {

    }

    const args = [
        'testem',
        !options.dev ? 'ci' : '',
        '-p', port,
        '-f', `test/testem.${suite}.js`,
        '-l', options.context.map(_.upperFirst).join(',')
    ];

    cp.spawn(args.join(' '), {
        cwd: wd,
        env: {
            ...process.env,
            TEST_FILES: (tests || []).join(','),
            NODE_CMD: ['qunit', 'test/node_test_setup.js', 'test/lib'].concat(tests || `test/${suite}`).join(' '),
            VERBOSE: Number(options.verbose),
            QUNIT_DEBUG_VISUAL_TESTS: Number(options.debug),
            QUNIT_RECREATE_VISUAL_REFS: Number(options.recreate),
            QUNIT_FILTER: options.filter,
            REPORT_FILE: options.out
        },
        shell: true,
        stdio: 'inherit',
        detached: options.dev
    })
        .on('exit', (code) => {
            // propagate failed exit code to the process for ci to fail
            // don't exit if tests passed - this is for parallel local testing
            code && process.exit(code);
        });

    if (options.launch) {
        // open localhost
        const url = `http://localhost:${port}/`;
        const start = (os.platform() === 'darwin' ? 'open' : os.platform() === 'win32' ? 'start' : 'xdg-open');
        cp.exec([start, url].join(' '));
    }
}

/**
 *
 * @param {'unit'|'visual'} type correspondes to the test directories
 * @returns
 */
function listTestFiles(type) {
    return fs.readdirSync(path.resolve(wd, './test', type)).filter(p => {
        const ext = path.parse(p).ext.slice(1);
        return ext === 'js' || ext === 'ts';
    });
}

function writeCLIFile(tests) {
    fs.writeFileSync(CLI_CACHE, JSON.stringify(tests, null, '\t'));
}

function readCLIFile() {
    return fs.existsSync(CLI_CACHE) ? require(CLI_CACHE) : [];
}

function createChoiceData(type, file) {
    return {
        name: `${type}/${file}`,
        short: `${type}/${file}`,
        value: {
            type,
            file
        }
    }
}

async function selectFileToTransform() {
    const files = _.map(listFiles(), ({ dir, file }) => createChoiceData(path.relative(path.resolve(wd, 'src'), dir).replaceAll('\\', '/'), file));
    const { tests: filteredTests } = await inquirer.prompt([
        {
            type: 'test-selection',
            name: 'tests',
            message: 'Select files to transform to es6',
            highlight: true,
            searchable: true,
            default: [],
            pageSize: 10,
            source(answersSoFar, input = '') {
                return new Promise(resolve => {
                    const value = _.map(this.getCurrentValue(), value => createChoiceData(value.type, value.file));
                    const res = fuzzy.filter(input, files, {
                        extract: (item) => item.name
                    }).map((element) => element.original);
                    resolve(value.concat(_.differenceBy(res, value, 'name')));
                });
            }
        }
    ]);
    return filteredTests.map(({ type, file }) => path.resolve(wd, 'src', type, file));
}

async function selectTestFile() {
    const selected = readCLIFile();
    const unitTests = listTestFiles('unit').map(file => createChoiceData('unit', file));
    const visualTests = listTestFiles('visual').map(file => createChoiceData('visual', file));
    const { tests: filteredTests } = await inquirer.prompt([
        {
            type: 'test-selection',
            name: 'tests',
            message: 'Select test files',
            highlight: true,
            searchable: true,
            default: selected,
            pageSize: Math.max(10, selected.length),
            source(answersSoFar, input = '') {
                return new Promise(resolve => {
                    const tests = _.concat(unitTests, visualTests);
                    const value = _.map(this.getCurrentValue(), value => createChoiceData(value.type, value.file));
                    if (value.length > 0) {
                        if (value.find(v => v.value && v.value.type === 'unit' && !v.value.file)) {
                            _.pullAll(tests, unitTests);
                        }
                        if (value.find(v => v.value && v.value.type === 'visual' && !v.value.file)) {
                            _.pullAll(tests, visualTests);
                        }
                    }
                    const unitChoice = createChoiceData('unit', '');
                    const visualChoice = createChoiceData('visual', '');
                    !value.find(v => _.isEqual(v, unitChoice)) && value.push(unitChoice);
                    !value.find(v => _.isEqual(v, visualChoice)) && value.push(visualChoice);
                    if (value.length > 0) {
                        value.unshift(new inquirer.Separator());
                        value.push(new inquirer.Separator());
                    }
                    const res = fuzzy.filter(input, tests, {
                        extract: (item) => item.name
                    }).map((element) => element.original);
                    resolve(value.concat(_.differenceBy(res, value, 'name')));
                });
            }
        }
    ]);
    writeCLIFile(filteredTests);
    return filteredTests;
}

async function runIntreactiveTestSuite(options) {
    //  some tests fail because of some pollution when run from the same context
    // test(_.map(await selectTestFile(), curr => `test/${curr.type}/${curr.file}`))
    const tests = _.reduce(await selectTestFile(), (acc, curr) => {
        if (!curr.file) {
            acc[curr.type] = true;
        }
        else if (Array.isArray(acc[curr.type])) {
            acc[curr.type].push(`test/${curr.type}/${curr.file}`);
        }
        return acc;
    }, { unit: [], visual: [] });
    _.reduce(tests, async (queue, files, suite) => {
        await queue;
        if (files === true) {
            return test(suite, null, options);
        }
        else if (Array.isArray(files) && files.length > 0) {
            return test(suite, files, options);
        }
    }, Promise.resolve());
}

program
    .name('fabric.js')
    .description('fabric.js DEV CLI tools')
    .version(package.version)
    .showSuggestionAfterError();

program
    .command('start')
    .description('start fabricjs.com dev server and watch for changes')
    .action((options) => {
        exportToWebsite({
            watch: true
        });
        startWebsite();
    });

program
    .command('dev')
    .description('watch for changes in `src` and `test` directories')
    .action(() => {
        cp.spawn('npm run build -- -f -w', { stdio: 'inherit', shell: true });
        cp.spawn('npm run build-tests -- -w', { stdio: 'inherit', shell: true });
    });

program
    .command('build')
    .description('build dist')
    .option('-f, --fast', 'skip minifying')
    .option('-w, --watch')
    .option('-i, --input <...path>', 'specify the build input paths')
    .option('-o, --output <path>', 'specify the build output path')
    .option('-x, --exclude <exclude...>')
    .option('-m, --modules <modules...>')
    .action((options) => {
        build(options);
    });

program
    .command('test')
    .description('run test suite')
    .addOption(new commander.Option('-s, --suite <suite...>', 'test suite to run').choices(['unit', 'visual']))
    .option('-f, --file <file>', 'run a specific test file')
    .option('--filter <filter>', 'filter tests by name')
    .option('-a, --all', 'run all tests', false)
    .option('-d, --debug', 'debug visual tests by overriding refs (golden images) in case of visual changes', false)
    .option('-r, --recreate', 'recreate visual refs (golden images)', false)
    .option('-v, --verbose', 'log passing tests', false)
    .option('-l, --launch', 'launch tests in the browser', false)
    .option('--dev', 'runs testem in `dev` mode, without a `ci` flag', false)
    .addOption(new commander.Option('-c, --context <context...>', 'context to test in').choices(['node', 'chrome', 'firefox']).default(['node']))
    .option('-p, --port')
    .option('-o, --out <out>', 'path to report test results to')
    .option('--clear-cache', 'clear CLI test cache', false)
    .action((options) => {
        if (options.clearCache) {
            fs.removeSync(CLI_CACHE);
        }
        if (options.all) {
            options.suite = ['unit', 'visual'];
        }
        if (options.suite) {
            _.reduce(options.suite, async (queue, suite) => {
                await queue;
                return test(suite, null, options);
            }, Promise.resolve());
        }
        else if (options.file) {
            test(options.file.startsWith('visual') ? 'visual' : 'unit', [`test/${options.file}`], options);
        }
        else {
            runIntreactiveTestSuite(options);
        }
    });

const website = program
    .command('website')
    .description('fabricjs.com commands');

website
    .command('start')
    .description('start fabricjs.com dev server')
    .allowExcessArguments()
    .allowUnknownOption()
    .action(startWebsite);

website
    .command('export')
    .description('export files to fabricjs.com directory')
    .addOption(new commander.Option('-i, --include <what...>').choices(['build', 'tests']).default(['build', 'tests'], 'export all'))
    .option('-w, --watch')
    .action(exportToWebsite);

program
    .command('transform')
    .description('transforms files into es6')
    .option('-o, --overwrite', 'overwrite exisitng files', false)
    .option('-x, --no-exports', 'do not use exports')
    .option('-i, --index', 'create index files', false)
    .option('-ts, --typescript', 'transform into typescript', false)
    .option('-v, --verbose', 'verbose logging', true)
    .option('-a, --all', 'transform all files', false)
    .option('-d, --diff <branch>', 'compare against given branch (default: master) and transform all files with diff')
    .action(async ({ overwrite, exports, index, typescript, verbose, all, diff: gitRef } = {}) => {
        let files = [];
        if (gitRef) {
            gitRef = gitRef === true ? 'master' : gitRef;
            const { changes } = getGitInfo(gitRef);
            files = changes.map(change => path.resolve(wd, change));
        }
        else if (!all) {
            files = await selectFileToTransform();
        }
        transformFiles({
            overwriteExisitingFiles: overwrite,
            useExports: exports,
            createIndex: index,
            ext: typescript ? 'ts' : 'js',
            verbose,
            files
        });
    });

program.parse(process.argv);