
import * as bonk from "../src/lib"


const develop = () => {
    const e2e = (platform, productModel, artifact) => {
        const phone = bonk.resource("phone", { platform })
        const product = bonk.resource("product", { model: productModel })
        
        return bonk.unit("E2E " + platform, {
          workflow: "e2e.yml",
          inputs: [artifact, phone, product],
        })
      }
      
    const build = bonk.unit("build", { workflow: "build.yml" })
      
    const ios_build = build.artifact("build-ios")
    const android_build = build.artifact("build-android")
    
    const e2e_ios = e2e("ios", "sb3", ios_build)
    const e2e_android = e2e("android", "sb3", android_build)
    
    const workgroup = bonk.workgroup("develop", [build, e2e_ios, e2e_android])

    return workgroup
}

bonk.stick([
    bonk.push("develop", develop),
])
