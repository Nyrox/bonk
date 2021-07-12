import cac = require('cac')
import child_process = require("child_process")
import path = require('path')

const cli = cac.default()

cli
    .command('trial <event:args> <file>', 'Trial run a bonk file')
    .action((event, file, options) => {
        console.log(event, file, options)
        const filePath = path.resolve(process.cwd(), file);
        console.log(filePath)

        const output = child_process.spawnSync("npx", ["ts-node", filePath], { env: Object.assign( {
                ["BONK_EVENT"]: event,
                ["BONK_IS_TRIAL"]: "true",
            }, process.env)
        })

        console.log(output.output.toString())
    })

cli.help()
cli.parse()
