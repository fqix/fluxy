import protobuf from 'protobufjs'
import { gunzipSync } from 'node:zlib'

export function compileProtobuf(schemas: { source: string }[]) {
    const root = new protobuf.Root()
    for (const schema of schemas) protobuf.parse(schema.source, root, { keepCase: true })
    root.resolveAll()
    const types: string[] = []
    const visit = (namespace: protobuf.Namespace) => {
        for (const object of namespace.nestedArray) {
            if (object instanceof protobuf.Type) types.push(object.fullName.slice(1))
            if (object instanceof protobuf.Namespace) visit(object)
        }
    }
    visit(root)
    return { root, types }
}
export function decodeProtobuf(
    schemas: { source: string }[],
    typeName: string,
    bytes: Buffer,
    grpc = false,
    encoding = ''
) {
    const type = compileProtobuf(schemas).root.lookupType(typeName)
    const decode = (value: Buffer) =>
        type.toObject(type.decode(value), {
            longs: String,
            enums: String,
            bytes: String,
            defaults: false
        })
    if (!grpc) return decode(bytes)
    const messages = []
    let offset = 0
    while (offset < bytes.length) {
        if (bytes.length - offset < 5) throw new Error('Truncated gRPC frame header')
        const flag = bytes[offset],
            length = bytes.readUInt32BE(offset + 1)
        offset += 5
        if (length > 2 * 1024 * 1024 || offset + length > bytes.length)
            throw new Error('Truncated or oversized gRPC message')
        let body = bytes.subarray(offset, offset + length)
        if (flag === 1 && encoding === 'gzip')
            body = gunzipSync(body, { maxOutputLength: 2 * 1024 * 1024 })
        else if (flag !== 0) throw new Error('Unsupported gRPC compression')
        messages.push(decode(body))
        offset += length
        if (messages.length > 1000) throw new Error('Too many gRPC messages')
    }
    return messages
}
