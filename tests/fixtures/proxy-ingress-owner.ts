import { Store } from '../../src/main/storage/store'
import { ProxyEngine } from '../../src/main/capture/proxy'
import { unusedPort } from '../../src/main/tun/tun'

async function main() {
    const store = new Store(process.argv[2])
    store.settings.port = await unusedPort()
    const engine = new ProxyEngine(store, () => {})
    await engine.start()
    process.stdout.write(JSON.stringify({ public: store.settings.port }) + '\n')
}
void main().catch((error) => {
    console.error(error)
    process.exit(1)
})
