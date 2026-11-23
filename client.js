window.__ModuleLoader__.load({ id: "dsh-mobile-device-bridge", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict';

var React = require('react');

class PromiseResolver {
    #promise;
    get promise() { return this.#promise; }
    #resolve;
    #reject;
    #state = 'running';
    get state() { return this.#state; }
    constructor() {
        this.#promise = new Promise((resolve, reject) => {
            this.#resolve = resolve;
            this.#reject = reject;
        });
    }
    resolve = (value) => {
        this.#resolve(value);
        this.#state = 'resolved';
    };
    reject = (reason) => {
        this.#reject(reason);
        this.#state = 'rejected';
    };
}

class AsyncOperationManager {
    nextId;
    pendingResolvers = new Map();
    constructor(startId = 0) {
        this.nextId = startId;
    }
    add() {
        const id = this.nextId++;
        const resolver = new PromiseResolver();
        this.pendingResolvers.set(id, resolver);
        return [id, resolver.promise];
    }
    getResolver(id) {
        if (!this.pendingResolvers.has(id)) {
            return null;
        }
        const resolver = this.pendingResolvers.get(id);
        this.pendingResolvers.delete(id);
        return resolver;
    }
    resolve(id, result) {
        const resolver = this.getResolver(id);
        if (resolver !== null) {
            resolver.resolve(result);
            return true;
        }
        return false;
    }
    reject(id, reason) {
        const resolver = this.getResolver(id);
        if (resolver !== null) {
            resolver.reject(reason);
            return true;
        }
        return false;
    }
}

function delay(time) {
    return new Promise(resolve => {
        // Don't call `resolve` with any value.
        globalThis.setTimeout(() => resolve(), time);
    });
}

function isPromiseLike(value) {
    return typeof value === "object" && value !== null && "then" in value;
}

function advance(iterator, next) {
    while (true) {
        const { done, value } = iterator.next(next);
        if (done) {
            return value;
        }
        if (isPromiseLike(value)) {
            return value.then((value) => advance(iterator, { resolved: value }), (error) => advance(iterator, { error }));
        }
        next = value;
    }
}
/* #__NO_SIDE_EFFECTS__ */
function bipedal(fn, bindThis) {
    function result(...args) {
        const iterator = fn.call(this, function* (value) {
            if (isPromiseLike(value)) {
                const result = yield value;
                if ("resolved" in result) {
                    return result.resolved;
                }
                else {
                    throw result.error;
                }
            }
            return value;
        }, ...args);
        return advance(iterator, undefined);
    }
    {
        return result;
    }
}

/* Adapt default field serializer to universal field serializer */
function defaultFieldSerializer(serializer) {
    return (source, context) => {
        if ("buffer" in context) {
            const buffer = serializer(source, context);
            context.buffer.set(buffer, context.index);
            return buffer.length;
        }
        else {
            return serializer(source, context);
        }
    };
}
/* Adapt byob field serializer to universal field serializer */
function byobFieldSerializer(size, serializer) {
    return (source, context) => {
        if ("buffer" in context) {
            context.index ??= 0;
            serializer(source, context);
            return size;
        }
        else {
            const buffer = new Uint8Array(size);
            serializer(source, {
                buffer,
                index: 0,
                littleEndian: context.littleEndian,
            });
            return buffer;
        }
    };
}

/* #__NO_SIDE_EFFECTS__ */
// eslint-disable-next-line @typescript-eslint/max-params
function _field(size, type, serialize, deserialize, options) {
    const field = {
        size,
        type: type,
        serialize: type === "default"
            ? defaultFieldSerializer(serialize)
            : byobFieldSerializer(size, serialize),
        deserialize: bipedal(deserialize),
        omitInit: options?.omitInit,
    };
    if (options?.init) {
        field.init = options.init;
    }
    return field;
}
const field = _field;

const EmptyUint8Array = new Uint8Array(0);
function copyMaybeDifferentLength(dest, source, index, length) {
    if (source.length < length) {
        dest.set(source, index);
        // Clear trailing bytes
        dest.fill(0, index + source.length, index + length);
    }
    else if (source.length === length) {
        dest.set(source, index);
    }
    else {
        dest.set(source.subarray(0, length), index);
    }
}
/* #__NO_SIDE_EFFECTS__ */
function buffer(lengthOrField, converter) {
    // Fixed length
    if (typeof lengthOrField === "number") {
        let serialize;
        let deserialize;
        let init;
        if (lengthOrField === 0) {
            serialize = () => { };
            if (converter) {
                // eslint-disable-next-line require-yield
                deserialize = function* () {
                    return converter.convert(EmptyUint8Array);
                };
            }
            else {
                // eslint-disable-next-line require-yield
                deserialize = function* () {
                    return EmptyUint8Array;
                };
            }
        }
        else {
            serialize = (value, { buffer, index }) => copyMaybeDifferentLength(buffer, value, index, lengthOrField);
            if (converter) {
                deserialize = function* (then, reader) {
                    const array = reader.readExactly(lengthOrField);
                    return converter.convert(yield* then(array));
                };
                init = (value) => converter.back(value);
            }
            else {
                // eslint-disable-next-line require-yield
                deserialize = function* (_then, reader) {
                    const array = reader.readExactly(lengthOrField);
                    return array;
                };
            }
        }
        return field(lengthOrField, "byob", serialize, deserialize, { init });
    }
    // Declare length field
    // Some field types are `function`s
    if ((typeof lengthOrField === "object" ||
        typeof lengthOrField === "function") &&
        "serialize" in lengthOrField) {
        let deserialize;
        let init;
        if (converter) {
            deserialize = function* (then, reader, context) {
                const length = yield* then(lengthOrField.deserialize(reader, context));
                const array = length !== 0 ? reader.readExactly(length) : EmptyUint8Array;
                return converter.convert(yield* then(array));
            };
            init = (value) => converter.back(value);
        }
        else {
            deserialize = function* (then, reader, context) {
                const length = yield* then(lengthOrField.deserialize(reader, context));
                const array = length !== 0 ? reader.readExactly(length) : EmptyUint8Array;
                return array;
            };
        }
        return field(lengthOrField.size, "default", (value, { littleEndian }) => {
            if (lengthOrField.type === "default") {
                const lengthBuffer = lengthOrField.serialize(value.length, {
                    littleEndian,
                });
                if (value.length === 0) {
                    return lengthBuffer;
                }
                const result = new Uint8Array(lengthBuffer.length + value.length);
                result.set(lengthBuffer, 0);
                result.set(value, lengthBuffer.length);
                return result;
            }
            else {
                const result = new Uint8Array(lengthOrField.size + value.length);
                lengthOrField.serialize(value.length, {
                    buffer: result,
                    index: 0,
                    littleEndian,
                });
                result.set(value, lengthOrField.size);
                return result;
            }
        }, deserialize, { init });
    }
    // Reference existing length field
    if (typeof lengthOrField === "string") {
        let deserialize;
        let init;
        if (converter) {
            deserialize = function* (then, reader, { dependencies }) {
                const length = dependencies[lengthOrField];
                const array = length !== 0 ? reader.readExactly(length) : EmptyUint8Array;
                return converter.convert(yield* then(array));
            };
            init = (value, dependencies) => {
                const array = converter.back(value);
                dependencies[lengthOrField] = array.length;
                return array;
            };
        }
        else {
            // eslint-disable-next-line require-yield
            deserialize = function* (_then, reader, { dependencies }) {
                const length = dependencies[lengthOrField];
                const array = length !== 0 ? reader.readExactly(length) : EmptyUint8Array;
                return array;
            };
            init = (value, dependencies) => {
                const array = value;
                dependencies[lengthOrField] = array.length;
                return array;
            };
        }
        return field(0, "default", (source) => source, deserialize, { init });
    }
    let deserialize;
    let init;
    // Reference existing length field + length converter
    if (converter) {
        deserialize = function* (then, reader, { dependencies }) {
            const rawLength = dependencies[lengthOrField.field];
            const length = lengthOrField.convert(rawLength);
            const array = length !== 0 ? reader.readExactly(length) : EmptyUint8Array;
            return converter.convert(yield* then(array));
        };
        init = (value, dependencies) => {
            const array = converter.back(value);
            dependencies[lengthOrField.field] = lengthOrField.back(array.length);
            return array;
        };
    }
    else {
        // eslint-disable-next-line require-yield
        deserialize = function* (_then, reader, { dependencies }) {
            const rawLength = dependencies[lengthOrField.field];
            const length = lengthOrField.convert(rawLength);
            const array = length !== 0 ? reader.readExactly(length) : EmptyUint8Array;
            return array;
        };
        init = (value, dependencies) => {
            const array = value;
            dependencies[lengthOrField.field] = lengthOrField.back(array.length);
            return array;
        };
    }
    return field(0, "default", (source) => source, deserialize, { init });
}

// TODO: allow over reading (returning a `Uint8Array`, an `offset` and a `length`) to avoid copying
class ExactReadableEndedError extends Error {
    constructor() {
        super("ExactReadable ended");
    }
}
class Uint8ArrayExactReadable {
    #data;
    #position;
    get position() {
        return this.#position;
    }
    constructor(data) {
        this.#data = data;
        this.#position = 0;
    }
    readExactly(length) {
        if (this.#position + length > this.#data.length) {
            throw new ExactReadableEndedError();
        }
        const result = this.#data.subarray(this.#position, this.#position + length);
        this.#position += length;
        return result;
    }
}

class StructDeserializeError extends Error {
    constructor(message) {
        super(message);
    }
}
class StructNotEnoughDataError extends StructDeserializeError {
    constructor() {
        super("The underlying readable was ended before the struct was fully deserialized");
    }
}
class StructEmptyError extends StructDeserializeError {
    constructor() {
        super("The underlying readable doesn't contain any more struct");
    }
}
/* #__NO_SIDE_EFFECTS__ */
function struct(fields, options) {
    const fieldList = Object.entries(fields);
    let size = 0;
    let byob = true;
    for (const [, field] of fieldList) {
        size += field.size;
        if (byob && field.type !== "byob") {
            byob = false;
        }
    }
    const littleEndian = options.littleEndian;
    const extra = options.extra
        ? Object.getOwnPropertyDescriptors(options.extra)
        : undefined;
    return {
        littleEndian,
        fields,
        extra: options.extra,
        type: byob ? "byob" : "default",
        size,
        serialize(source, bufferOrContext) {
            const temp = { ...source };
            for (const [key, field] of fieldList) {
                if (key in temp && "init" in field) {
                    const result = field.init?.(temp[key], temp);
                    temp[key] = result;
                }
            }
            const sizes = new Array(fieldList.length);
            const buffers = new Array(fieldList.length);
            {
                const context = { littleEndian };
                for (const [index, [key, field]] of fieldList.entries()) {
                    if (field.type === "byob") {
                        sizes[index] = field.size;
                    }
                    else {
                        buffers[index] = field.serialize(temp[key], context);
                        sizes[index] = buffers[index].length;
                    }
                }
            }
            const size = sizes.reduce((sum, size) => sum + size, 0);
            let externalBuffer;
            let buffer;
            let index;
            if (bufferOrContext instanceof Uint8Array) {
                if (bufferOrContext.length < size) {
                    throw new Error("Buffer too small");
                }
                externalBuffer = true;
                buffer = bufferOrContext;
                index = 0;
            }
            else if (typeof bufferOrContext === "object" &&
                "buffer" in bufferOrContext) {
                externalBuffer = true;
                buffer = bufferOrContext.buffer;
                index = bufferOrContext.index ?? 0;
                if (buffer.length - index < size) {
                    throw new Error("Buffer too small");
                }
            }
            else {
                externalBuffer = false;
                buffer = new Uint8Array(size);
                index = 0;
            }
            const context = {
                buffer,
                index,
                littleEndian,
            };
            for (const [index, [key, field]] of fieldList.entries()) {
                if (buffers[index]) {
                    buffer.set(buffers[index], context.index);
                }
                else {
                    field.serialize(temp[key], context);
                }
                context.index += sizes[index];
            }
            if (externalBuffer) {
                return size;
            }
            else {
                return buffer;
            }
        },
        deserialize: bipedal(function* (then, reader) {
            const startPosition = reader.position;
            const result = {};
            const context = {
                dependencies: result,
                littleEndian: littleEndian,
            };
            try {
                for (const [key, field] of fieldList) {
                    result[key] = yield* then(field.deserialize(reader, context));
                }
            }
            catch (e) {
                if (!(e instanceof ExactReadableEndedError)) {
                    throw e;
                }
                if (reader.position === startPosition) {
                    throw new StructEmptyError();
                }
                else {
                    throw new StructNotEnoughDataError();
                }
            }
            if (extra) {
                Object.defineProperties(result, extra);
            }
            if (options.postDeserialize) {
                return options.postDeserialize.call(result, result);
            }
            else {
                return result;
            }
        }),
    };
}

/* #__NO_SIDE_EFFECTS__ */
function extend(base, fields, options) {
    return struct(Object.assign({}, base.fields, fields), {
        littleEndian: options?.littleEndian ?? base.littleEndian,
        extra: base.extra,
        postDeserialize: options?.postDeserialize,
    });
}

/* #__NO_SIDE_EFFECTS__ */
function getInt32(buffer, offset, littleEndian) {
    return littleEndian
        ? buffer[offset] |
            (buffer[offset + 1] << 8) |
            (buffer[offset + 2] << 16) |
            (buffer[offset + 3] << 24)
        : (buffer[offset] << 24) |
            (buffer[offset + 1] << 16) |
            (buffer[offset + 2] << 8) |
            buffer[offset + 3];
}
function setInt32(buffer, offset, value, littleEndian) {
    if (littleEndian) {
        buffer[offset] = value;
        buffer[offset + 1] = value >> 8;
        buffer[offset + 2] = value >> 16;
        buffer[offset + 3] = value >> 24;
    }
    else {
        buffer[offset] = value >> 24;
        buffer[offset + 1] = value >> 16;
        buffer[offset + 2] = value >> 8;
        buffer[offset + 3] = value;
    }
}

function setInt64LittleEndian(buffer, offset, value) {
    buffer[offset] = Number(value & 0xffn);
    buffer[offset + 1] = Number((value >> 8n) & 0xffn);
    buffer[offset + 2] = Number((value >> 16n) & 0xffn);
    buffer[offset + 3] = Number((value >> 24n) & 0xffn);
    buffer[offset + 4] = Number((value >> 32n) & 0xffn);
    buffer[offset + 5] = Number((value >> 40n) & 0xffn);
    buffer[offset + 6] = Number((value >> 48n) & 0xffn);
    buffer[offset + 7] = Number((value >> 56n) & 0xffn);
}
function setInt64BigEndian(buffer, offset, value) {
    buffer[offset] = Number((value >> 56n) & 0xffn);
    buffer[offset + 1] = Number((value >> 48n) & 0xffn);
    buffer[offset + 2] = Number((value >> 40n) & 0xffn);
    buffer[offset + 3] = Number((value >> 32n) & 0xffn);
    buffer[offset + 4] = Number((value >> 24n) & 0xffn);
    buffer[offset + 5] = Number((value >> 16n) & 0xffn);
    buffer[offset + 6] = Number((value >> 8n) & 0xffn);
    buffer[offset + 7] = Number(value & 0xffn);
}

/* #__NO_SIDE_EFFECTS__ */
function getUint32LittleEndian(buffer, offset) {
    return ((buffer[offset] |
        (buffer[offset + 1] << 8) |
        (buffer[offset + 2] << 16) |
        (buffer[offset + 3] << 24)) >>>
        0);
}
/* #__NO_SIDE_EFFECTS__ */
function getUint32(buffer, offset, littleEndian) {
    return littleEndian
        ? (buffer[offset] |
            (buffer[offset + 1] << 8) |
            (buffer[offset + 2] << 16) |
            (buffer[offset + 3] << 24)) >>>
            0
        : ((buffer[offset] << 24) |
            (buffer[offset + 1] << 16) |
            (buffer[offset + 2] << 8) |
            buffer[offset + 3]) >>>
            0;
}
function setUint32LittleEndian(buffer, offset, value) {
    buffer[offset] = value;
    buffer[offset + 1] = value >> 8;
    buffer[offset + 2] = value >> 16;
    buffer[offset + 3] = value >> 24;
}
function setUint32(buffer, offset, value, littleEndian) {
    if (littleEndian) {
        buffer[offset] = value;
        buffer[offset + 1] = value >> 8;
        buffer[offset + 2] = value >> 16;
        buffer[offset + 3] = value >> 24;
    }
    else {
        buffer[offset] = value >> 24;
        buffer[offset + 1] = value >> 16;
        buffer[offset + 2] = value >> 8;
        buffer[offset + 3] = value;
    }
}

function getUint64BigEndian(buffer, offset) {
    return ((BigInt(buffer[offset]) << 56n) |
        (BigInt(buffer[offset + 1]) << 48n) |
        (BigInt(buffer[offset + 2]) << 40n) |
        (BigInt(buffer[offset + 3]) << 32n) |
        (BigInt(buffer[offset + 4]) << 24n) |
        (BigInt(buffer[offset + 5]) << 16n) |
        (BigInt(buffer[offset + 6]) << 8n) |
        BigInt(buffer[offset + 7]));
}
function getUint64(buffer, offset, littleEndian) {
    return littleEndian
        ? BigInt(buffer[offset]) |
            (BigInt(buffer[offset + 1]) << 8n) |
            (BigInt(buffer[offset + 2]) << 16n) |
            (BigInt(buffer[offset + 3]) << 24n) |
            (BigInt(buffer[offset + 4]) << 32n) |
            (BigInt(buffer[offset + 5]) << 40n) |
            (BigInt(buffer[offset + 6]) << 48n) |
            (BigInt(buffer[offset + 7]) << 56n)
        : (BigInt(buffer[offset]) << 56n) |
            (BigInt(buffer[offset + 1]) << 48n) |
            (BigInt(buffer[offset + 2]) << 40n) |
            (BigInt(buffer[offset + 3]) << 32n) |
            (BigInt(buffer[offset + 4]) << 24n) |
            (BigInt(buffer[offset + 5]) << 16n) |
            (BigInt(buffer[offset + 6]) << 8n) |
            BigInt(buffer[offset + 7]);
}
function setUint64(buffer, offset, value, littleEndian) {
    if (littleEndian) {
        buffer[offset] = Number(value & 0xffn);
        buffer[offset + 1] = Number((value >> 8n) & 0xffn);
        buffer[offset + 2] = Number((value >> 16n) & 0xffn);
        buffer[offset + 3] = Number((value >> 24n) & 0xffn);
        buffer[offset + 4] = Number((value >> 32n) & 0xffn);
        buffer[offset + 5] = Number((value >> 40n) & 0xffn);
        buffer[offset + 6] = Number((value >> 48n) & 0xffn);
        buffer[offset + 7] = Number((value >> 56n) & 0xffn);
    }
    else {
        buffer[offset] = Number((value >> 56n) & 0xffn);
        buffer[offset + 1] = Number((value >> 48n) & 0xffn);
        buffer[offset + 2] = Number((value >> 40n) & 0xffn);
        buffer[offset + 3] = Number((value >> 32n) & 0xffn);
        buffer[offset + 4] = Number((value >> 24n) & 0xffn);
        buffer[offset + 5] = Number((value >> 16n) & 0xffn);
        buffer[offset + 6] = Number((value >> 8n) & 0xffn);
        buffer[offset + 7] = Number(value & 0xffn);
    }
}

/* #__NO_SIDE_EFFECTS__ */
function number(size, serialize, deserialize) {
    const fn = (() => fn);
    Object.assign(fn, field(size, "byob", serialize, deserialize));
    return fn;
}
const u8 = number(1, (value, { buffer, index }) => {
    buffer[index] = value;
}, function* (then, reader) {
    const data = yield* then(reader.readExactly(1));
    return data[0];
});
const u32 = number(4, (value, { buffer, index, littleEndian }) => {
    setUint32(buffer, index, value, littleEndian);
}, function* (then, reader, { littleEndian }) {
    const data = yield* then(reader.readExactly(4));
    return getUint32(data, 0, littleEndian);
});
const s32 = number(4, (value, { buffer, index, littleEndian }) => {
    setInt32(buffer, index, value, littleEndian);
}, function* (then, reader, { littleEndian }) {
    const data = yield* then(reader.readExactly(4));
    return getInt32(data, 0, littleEndian);
});
const u64 = number(8, (value, { buffer, index, littleEndian }) => {
    setUint64(buffer, index, value, littleEndian);
}, function* (then, reader, { littleEndian }) {
    const data = yield* then(reader.readExactly(8));
    return getUint64(data, 0, littleEndian);
});

// This library can't use `@types/node` or `lib: dom`
// because they will pollute the global scope
// So `TextEncoder` and `TextDecoder` types are not available
const { TextEncoder: TextEncoder$1, TextDecoder: TextDecoder$1 } = globalThis;
const SharedEncoder = /* #__PURE__ */ new TextEncoder$1();
const SharedDecoder = /* #__PURE__ */ new TextDecoder$1();
/* #__NO_SIDE_EFFECTS__ */
function encodeUtf8(input) {
    return SharedEncoder.encode(input);
}
/* #__NO_SIDE_EFFECTS__ */
function decodeUtf8(buffer) {
    // `TextDecoder` has internal states in stream mode,
    // but this method is not for stream mode, so the instance can be reused
    return SharedDecoder.decode(buffer);
}

// Prettier will move the annotation and make it invalid
// prettier-ignore
const string = ( /* #__NO_SIDE_EFFECTS__ */(lengthOrField) => {
    const field = buffer(lengthOrField, {
        convert: decodeUtf8,
        back: encodeUtf8,
    });
    field.as = () => field;
    return field;
});

const { AbortController } = globalThis;
const ReadableStream$1 = /* #__PURE__ */ (() => {
    const { ReadableStream } = globalThis;
    if (!ReadableStream.from) {
        ReadableStream.from = function (iterable) {
            const iterator = Symbol.asyncIterator in iterable
                ? iterable[Symbol.asyncIterator]()
                : iterable[Symbol.iterator]();
            return new ReadableStream({
                async pull(controller) {
                    const result = await iterator.next();
                    if (result.done) {
                        controller.close();
                        return;
                    }
                    controller.enqueue(result.value);
                },
                async cancel(reason) {
                    await iterator.return?.(reason);
                },
            });
        };
    }
    if (!ReadableStream.prototype[Symbol.asyncIterator] ||
        !ReadableStream.prototype.values) {
        ReadableStream.prototype.values = async function* (options) {
            const reader = this.getReader();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        return;
                    }
                    yield value;
                }
            }
            finally {
                // Calling `iterator.return` will enter this `finally` block.
                // We don't need to care about the parameter to `iterator.return`,
                // it will be returned as the final `result.value` automatically.
                if (!options?.preventCancel) {
                    await reader.cancel();
                }
                reader.releaseLock();
            }
        };
        ReadableStream.prototype[Symbol.asyncIterator] =
            // eslint-disable-next-line @typescript-eslint/unbound-method
            ReadableStream.prototype.values;
    }
    return ReadableStream;
})();
const { WritableStream, TransformStream } = globalThis;

class TaskQueue {
    #ready;
    #disposed = false;
    enqueue(task, bail = false) {
        if (this.#disposed) {
            throw new Error("TaskQueue is disposed");
        }
        if (!this.#ready) {
            // Init state or all previous tasks are synchronous
            try {
                const result = task();
                if (isPromiseLike(result)) {
                    this.#ready = result.then(() => { }, (e) => {
                        if (bail) {
                            throw e;
                        }
                    });
                }
                return result;
            }
            catch (e) {
                if (bail) {
                    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
                    const promise = Promise.reject(e);
                    // Suppress unhandled-rejection without resolving `#ready`
                    void promise.catch(() => { });
                    this.#ready = promise;
                }
                throw e;
            }
        }
        const result = this.#ready.then(() => {
            if (this.#disposed) {
                throw new Error("TaskQueue is disposed");
            }
            return task();
        });
        this.#ready = result.then(() => { }, (e) => {
            if (bail || this.#disposed) {
                throw e;
            }
        });
        return result;
    }
    dispose() {
        this.#disposed = true;
    }
}

class PushReadableStream extends ReadableStream$1 {
    /**
     * Create a new `PushReadableStream` from a source.
     *
     * @param source If `source` returns a `Promise`, the stream will be closed
     * when the `Promise` is resolved, and be errored when the `Promise` is rejected.
     * @param strategy
     */
    constructor(source, strategy, logger) {
        let controller;
        const tasks = new TaskQueue();
        let zeroHighWaterMarkAllowEnqueue = false;
        // Resolves when consumer calls `reader.read`.
        // Rejects when producer calls `controller.close` or `controller.error`,
        // or consumer calls `reader.cancel`.
        let waterMarkLow;
        const abortController = new AbortController();
        // Whether either the consumer has called `stream.cancel()`,
        // or the producer has called `controller.close` or `controller.error`.
        let stopped = false;
        const enqueue = (chunk) => {
            logger?.({
                source: "producer",
                operation: "enqueue",
                value: chunk,
                phase: "start",
            });
            if (abortController.signal.aborted) {
                // In original `ReadableStream`, calling `enqueue` or `close`
                // on an cancelled stream will throw an error,
                //
                // But in `PushReadableStream`, `enqueue` is an async function,
                // the producer can't just check `abortSignal.aborted`
                // before calling `enqueue`, as it might change when waiting
                // for the backpressure to be reduced.
                //
                // So IMO it's better to handle this for the producer
                // by simply ignoring the `enqueue` call.
                //
                // Note that we check `abortSignal.aborted` instead of `stopped`,
                // as it's not allowed for the producer to call `enqueue` after
                // they called `close` or `error`.
                //
                // Obviously, the producer should listen to the `abortSignal` and
                // stop producing, but most pushing data sources don't support that.
                logger?.({
                    source: "producer",
                    operation: "enqueue",
                    value: chunk,
                    phase: "ignored",
                });
                return false;
            }
            if (controller.desiredSize === null) {
                // `desiredSize` being `null` means the stream is in error state,
                // `controller.enqueue` will throw an error for us.
                controller.enqueue(chunk);
                // istanbul ignore next
                throw new Error("unreachable");
            }
            if (zeroHighWaterMarkAllowEnqueue) {
                // When `highWaterMark` is set to `0`,
                // `controller.desiredSize` will always be `0`,
                // even if the consumer has called `reader.read()`.
                // (in this case, each `reader.read()`/`pull`
                // should allow one `enqueue` of any size)
                //
                // If the consumer has already called `reader.read()`,
                // before the producer tries to `enqueue`,
                // `controller.desiredSize` is `0` and normal `waterMarkLow` signal
                // will never trigger,
                // (because `ReadableStream` prevents reentrance of `pull`)
                // The stream will stuck.
                //
                // So we need a special signal for this case.
                zeroHighWaterMarkAllowEnqueue = false;
                controller.enqueue(chunk);
                logger?.({
                    source: "producer",
                    operation: "enqueue",
                    value: chunk,
                    phase: "complete",
                });
                return true;
            }
            if (controller.desiredSize <= 0) {
                logger?.({
                    source: "producer",
                    operation: "enqueue",
                    value: chunk,
                    phase: "waiting",
                });
                waterMarkLow = new PromiseResolver();
                return waterMarkLow.promise.then(() => {
                    controller.enqueue(chunk);
                    logger?.({
                        source: "producer",
                        operation: "enqueue",
                        value: chunk,
                        phase: "complete",
                    });
                    return true;
                }, () => {
                    // Only ignore this in-flight `enqueue` call
                    // future calls will trigger `desiredSize === null` and throw
                    logger?.({
                        source: "producer",
                        operation: "enqueue",
                        value: chunk,
                        phase: "ignored",
                    });
                    return false;
                });
            }
            controller.enqueue(chunk);
            logger?.({
                source: "producer",
                operation: "enqueue",
                value: chunk,
                phase: "complete",
            });
            return true;
        };
        const close = (explicit) => {
            logger?.({
                source: "producer",
                operation: "close",
                explicit,
                phase: "start",
            });
            // Allow calling `controller.close` on cancelled stream as `enqueue` does
            // Ignore implicit close on any stopped state
            // But don't allow calling `controller.close` multiple times
            if (abortController.signal.aborted || (stopped && !explicit)) {
                logger?.({
                    source: "producer",
                    operation: "close",
                    explicit,
                    phase: "ignored",
                });
                return;
            }
            // This will throw for us if the stream is not in `readable` state
            controller.close();
            stopped = true;
            // Wake up pending `enqueue`
            waterMarkLow?.reject();
            logger?.({
                source: "producer",
                operation: "close",
                explicit,
                phase: "complete",
            });
        };
        const error = (error, explicit) => {
            logger?.({
                source: "producer",
                operation: "error",
                explicit,
                phase: "start",
            });
            stopped = true;
            // `controller.error` won't throw on closed/errored/cancelled stream
            // so don't need any checks
            controller.error(error);
            // Wake up pending `enqueue`
            waterMarkLow?.reject();
            logger?.({
                source: "producer",
                operation: "error",
                explicit,
                phase: "complete",
            });
        };
        super({
            start: (controller_) => {
                controller = controller_;
                const result = source({
                    abortSignal: abortController.signal,
                    enqueue: async (chunk) => 
                    // Run `enqueue`s in serial
                    // Use `async/await` to always return a `Promise`
                    await tasks.enqueue(() => enqueue(chunk)),
                    close() {
                        close(true);
                    },
                    error(e) {
                        error(e, true);
                    },
                });
                if (!stopped && isPromiseLike(result)) {
                    // If `source` returns a `Promise`,
                    // close the stream when the `Promise` is resolved,
                    // and error the stream when the `Promise` is rejected.
                    // The producer can return a never-settling `Promise`
                    // to disable this behavior.
                    result.then(() => close(false), (e) => error(e, false));
                }
            },
            pull: () => {
                logger?.({
                    source: "consumer",
                    operation: "pull",
                    phase: "start",
                });
                if (waterMarkLow) {
                    waterMarkLow.resolve(undefined);
                    waterMarkLow = undefined;
                }
                else if (strategy?.highWaterMark === 0) {
                    zeroHighWaterMarkAllowEnqueue = true;
                }
                logger?.({
                    source: "consumer",
                    operation: "pull",
                    phase: "complete",
                });
            },
            cancel: (reason) => {
                logger?.({
                    source: "consumer",
                    operation: "cancel",
                    phase: "start",
                });
                stopped = true;
                abortController.abort(reason);
                waterMarkLow?.reject();
                logger?.({
                    source: "consumer",
                    operation: "cancel",
                    phase: "complete",
                });
            },
        }, strategy);
    }
}

function tryClose(value) {
    try {
        const result = value.close();
        if (isPromiseLike(result)) {
            return result.then(() => true, () => false);
        }
        return true;
    }
    catch {
        return false;
    }
}
async function tryCancel(stream) {
    try {
        await stream.cancel();
        return true;
    }
    catch {
        return false;
    }
}

class BufferedReadableStream {
    #buffered;
    // PERF: `subarray` is slow
    // don't use it until absolutely necessary
    #bufferedOffset = 0;
    #bufferedLength = 0;
    #position = 0;
    get position() {
        return this.#position;
    }
    stream;
    reader;
    constructor(stream) {
        this.stream = stream;
        this.reader = stream.getReader();
    }
    #readBuffered(length) {
        if (!this.#buffered) {
            return undefined;
        }
        const value = this.#buffered.subarray(this.#bufferedOffset, this.#bufferedOffset + length);
        // PERF: Synchronous path for reading from internal buffer
        if (this.#bufferedLength > length) {
            this.#position += length;
            this.#bufferedOffset += length;
            this.#bufferedLength -= length;
            return value;
        }
        this.#position += this.#bufferedLength;
        this.#buffered = undefined;
        this.#bufferedOffset = 0;
        this.#bufferedLength = 0;
        return value;
    }
    async #readSource(length) {
        const { done, value } = await this.reader.read();
        if (done) {
            throw new ExactReadableEndedError();
        }
        if (value.length > length) {
            this.#buffered = value;
            this.#bufferedOffset = length;
            this.#bufferedLength = value.length - length;
            this.#position += length;
            return value.subarray(0, length);
        }
        this.#position += value.length;
        return value;
    }
    iterateExactly(length) {
        let state = this.#buffered ? 0 : 1;
        return {
            next: () => {
                switch (state) {
                    case 0: {
                        const value = this.#readBuffered(length);
                        if (value.length === length) {
                            state = 2;
                        }
                        else {
                            length -= value.length;
                            state = 1;
                        }
                        return { done: false, value };
                    }
                    case 1:
                        state = 3;
                        return {
                            done: false,
                            value: this.#readSource(length).then((value) => {
                                if (value.length === length) {
                                    state = 2;
                                }
                                else {
                                    length -= value.length;
                                    state = 1;
                                }
                                return value;
                            }),
                        };
                    case 2:
                        return { done: true, value: undefined };
                    case 3:
                        throw new Error("Can't call `next` before previous Promise resolves");
                    default:
                        throw new Error("unreachable");
                }
            },
        };
    }
    readExactly = bipedal(function* (then, length) {
        let result;
        let index = 0;
        const initial = this.#readBuffered(length);
        if (initial) {
            if (initial.length === length) {
                return initial;
            }
            result = new Uint8Array(length);
            result.set(initial, index);
            index += initial.length;
            length -= initial.length;
        }
        else {
            result = new Uint8Array(length);
        }
        while (length > 0) {
            const value = yield* then(this.#readSource(length));
            result.set(value, index);
            index += value.length;
            length -= value.length;
        }
        return result;
    });
    /**
     * Return a readable stream with unconsumed data (if any) and
     * all data from the wrapped stream.
     * @returns A `ReadableStream`
     */
    release() {
        if (this.#bufferedLength > 0) {
            return new PushReadableStream(async (controller) => {
                // Put the remaining data back to the stream
                const buffered = this.#buffered.subarray(this.#bufferedOffset);
                await controller.enqueue(buffered);
                controller.abortSignal.addEventListener("abort", () => {
                    void tryCancel(this.reader);
                });
                // Manually pipe the stream
                while (true) {
                    const { done, value } = await this.reader.read();
                    if (done) {
                        return;
                    }
                    await controller.enqueue(value);
                }
            });
        }
        else {
            // Simply release the reader and return the stream
            this.reader.releaseLock();
            return this.stream;
        }
    }
    async cancel(reason) {
        await this.reader.cancel(reason);
    }
}

// TODO: BufferedTransformStream: find better implementation
class BufferedTransformStream {
    #readable;
    get readable() {
        return this.#readable;
    }
    #writable;
    get writable() {
        return this.#writable;
    }
    constructor(transform) {
        // Convert incoming chunks to a `BufferedReadableStream`
        let bufferedStreamController;
        let writableStreamController;
        const buffered = new BufferedReadableStream(new PushReadableStream((controller) => {
            bufferedStreamController = controller;
        }));
        this.#readable = new ReadableStream$1({
            async pull(controller) {
                try {
                    const value = await transform(buffered);
                    controller.enqueue(value);
                }
                catch (e) {
                    // Treat `StructEmptyError` as a normal end.
                    // If the `transform` method doesn't have enough data to return a value,
                    // it should throw another error to indicate that.
                    if (e instanceof StructEmptyError) {
                        controller.close();
                        return;
                    }
                    throw e;
                }
            },
            cancel: (reason) => {
                // If a `ReadableStream` is piping into `#writable`,
                // This will cancel the `ReadableStream` immediately.
                // If upstream is writing using `#writable`'s writer, this will
                // throw errors for any future writes
                return writableStreamController.error(reason);
            },
        });
        this.#writable = new WritableStream({
            start(controller) {
                writableStreamController = controller;
            },
            async write(chunk) {
                await bufferedStreamController.enqueue(chunk);
            },
            abort() {
                bufferedStreamController.close();
            },
            close() {
                bufferedStreamController.close();
            },
        });
    }
}

// `TransformStream` only calls its `source.flush` method when its `readable` is being read.
// If the user want to use the `Promise` interface, the `flush` method will never be called,
// so the `PromiseResolver` will never be resolved.
// Thus we need to implement our own `TransformStream` using a `WritableStream` and a `ReadableStream`.
/**
 * A `TransformStream` that concatenates strings.
 *
 * Its `readable` is also a `Promise<string>`, so it's possible to `await` it to get the result.
 *
 * ```ts
 * const result: string = await readable.pipeThrough(new ConcatStringStream());
 * ```
 */
class ConcatStringStream {
    // PERF: rope (concat strings) is faster than `[].join('')`
    #result = "";
    #resolver = new PromiseResolver();
    #writable = new WritableStream({
        write: (chunk) => {
            this.#result += chunk;
        },
        close: () => {
            this.#resolver.resolve(this.#result);
            this.#readableController.enqueue(this.#result);
            this.#readableController.close();
        },
        abort: (reason) => {
            this.#resolver.reject(reason);
            this.#readableController.error(reason);
        },
    });
    get writable() {
        return this.#writable;
    }
    #readableController;
    #readable = new ReadableStream$1({
        start: (controller) => {
            this.#readableController = controller;
        },
    });
    get readable() {
        return this.#readable;
    }
    constructor() {
        void Object.defineProperties(this.#readable, {
            then: {
                get: () => this.#resolver.promise.then.bind(this.#resolver.promise),
            },
            catch: {
                get: () => this.#resolver.promise.catch.bind(this.#resolver.promise),
            },
            finally: {
                get: () => this.#resolver.promise.finally.bind(this.#resolver.promise),
            },
        });
    }
}
/**
 * A `TransformStream` that concatenates `Uint8Array`s.
 *
 * If you want to decode the result as string,
 * prefer `.pipeThrough(new TextDecoderStream()).pipeThrough(new ConcatStringStream())`,
 * than `.pipeThough(new ConcatBufferStream()).pipeThrough(new TextDecoderStream())`,
 * because of JavaScript engine optimizations,
 * concatenating strings is faster than concatenating `Uint8Array`s.
 */
class ConcatBufferStream {
    #segments = [];
    #resolver = new PromiseResolver();
    #writable = new WritableStream({
        write: (chunk) => {
            this.#segments.push(chunk);
        },
        close: () => {
            let result;
            let offset = 0;
            switch (this.#segments.length) {
                case 0:
                    result = EmptyUint8Array;
                    break;
                case 1:
                    result = this.#segments[0];
                    break;
                default:
                    result = new Uint8Array(this.#segments.reduce((prev, item) => prev + item.length, 0));
                    for (const segment of this.#segments) {
                        result.set(segment, offset);
                        offset += segment.length;
                    }
                    break;
            }
            this.#resolver.resolve(result);
            this.#readableController.enqueue(result);
            this.#readableController.close();
        },
        abort: (reason) => {
            this.#resolver.reject(reason);
            this.#readableController.error(reason);
        },
    });
    get writable() {
        return this.#writable;
    }
    #readableController;
    #readable = new ReadableStream$1({
        start: (controller) => {
            this.#readableController = controller;
        },
    });
    get readable() {
        return this.#readable;
    }
    constructor() {
        void Object.defineProperties(this.#readable, {
            then: {
                get: () => this.#resolver.promise.then.bind(this.#resolver.promise),
            },
            catch: {
                get: () => this.#resolver.promise.catch.bind(this.#resolver.promise),
            },
            finally: {
                get: () => this.#resolver.promise.finally.bind(this.#resolver.promise),
            },
        });
    }
}

class ConsumableReadableStream extends ReadableStream$1 {
    static async enqueue(controller, chunk) {
        const output = new Consumable(chunk);
        controller.enqueue(output);
        await output.consumed;
    }
    constructor(source, strategy) {
        let wrappedController;
        let wrappedStrategy;
        if (strategy) {
            wrappedStrategy = {};
            if ("highWaterMark" in strategy) {
                wrappedStrategy.highWaterMark = strategy.highWaterMark;
            }
            if ("size" in strategy) {
                wrappedStrategy.size = (chunk) => {
                    return strategy.size(chunk.value);
                };
            }
        }
        super({
            start(controller) {
                wrappedController = {
                    enqueue(chunk) {
                        return ConsumableReadableStream.enqueue(controller, chunk);
                    },
                    close() {
                        controller.close();
                    },
                    error(reason) {
                        controller.error(reason);
                    },
                };
                return source.start?.(wrappedController);
            },
            pull() {
                return source.pull?.(wrappedController);
            },
            cancel(reason) {
                return source.cancel?.(reason);
            },
        }, wrappedStrategy);
    }
}

class ConsumableWrapByteReadableStream extends ReadableStream$1 {
    constructor(stream, chunkSize, min) {
        const reader = stream.getReader({ mode: "byob" });
        let array = new Uint8Array(chunkSize);
        super({
            async pull(controller) {
                const { done, value } = await reader.read(array, { min });
                if (done) {
                    controller.close();
                    return;
                }
                await ConsumableReadableStream.enqueue(controller, value);
                array = new Uint8Array(value.buffer);
            },
            cancel(reason) {
                return reader.cancel(reason);
            },
        });
    }
}

class ConsumableWrapWritableStream extends WritableStream {
    constructor(stream) {
        const writer = stream.getWriter();
        super({
            write(chunk) {
                return chunk.tryConsume((chunk) => writer.write(chunk));
            },
            abort(reason) {
                return writer.abort(reason);
            },
            close() {
                return writer.close();
            },
        });
    }
}

class ConsumableWritableStream extends WritableStream {
    static async write(writer, value) {
        const consumable = new Consumable(value);
        await writer.write(consumable);
        await consumable.consumed;
    }
    constructor(sink, strategy) {
        let wrappedStrategy;
        if (strategy) {
            wrappedStrategy = {};
            if ("highWaterMark" in strategy) {
                wrappedStrategy.highWaterMark = strategy.highWaterMark;
            }
            if ("size" in strategy) {
                wrappedStrategy.size = (chunk) => {
                    return strategy.size(chunk instanceof Consumable ? chunk.value : chunk);
                };
            }
        }
        super({
            start(controller) {
                return sink.start?.(controller);
            },
            write(chunk, controller) {
                return chunk.tryConsume((chunk) => sink.write?.(chunk, controller));
            },
            abort(reason) {
                return sink.abort?.(reason);
            },
            close() {
                return sink.close?.();
            },
        }, wrappedStrategy);
    }
}

// `createTask` allows browser DevTools to track the call stack across async boundaries.
const { console: console$1 } = globalThis;
const createTask = /* #__PURE__ */ (() => console$1?.createTask?.bind(console$1) ??
    (() => ({
        run(callback) {
            return callback();
        },
    })))();

class Consumable {
    static WritableStream = ConsumableWritableStream;
    static WrapWritableStream = ConsumableWrapWritableStream;
    static ReadableStream = ConsumableReadableStream;
    static WrapByteReadableStream = ConsumableWrapByteReadableStream;
    #task;
    #resolver;
    value;
    consumed;
    constructor(value) {
        this.#task = createTask("Consumable");
        this.value = value;
        this.#resolver = new PromiseResolver();
        this.consumed = this.#resolver.promise;
    }
    consume() {
        this.#resolver.resolve();
    }
    error(error) {
        this.#resolver.reject(error);
    }
    tryConsume(callback) {
        try {
            let result = this.#task.run(() => callback(this.value));
            if (isPromiseLike(result)) {
                result = result.then((value) => {
                    this.#resolver.resolve();
                    return value;
                }, (e) => {
                    this.#resolver.reject(e);
                    throw e;
                });
            }
            else {
                this.#resolver.resolve();
            }
            return result;
        }
        catch (e) {
            this.#resolver.reject(e);
            throw e;
        }
    }
}

function tryConsume(value, callback) {
    if (value instanceof Consumable) {
        return value.tryConsume(callback);
    }
    else {
        return callback(value);
    }
}

class MaybeConsumableWritableStream extends WritableStream {
    constructor(sink, strategy) {
        let wrappedStrategy;
        if (strategy) {
            wrappedStrategy = {};
            if ("highWaterMark" in strategy) {
                wrappedStrategy.highWaterMark = strategy.highWaterMark;
            }
            if ("size" in strategy) {
                wrappedStrategy.size = (chunk) => {
                    return strategy.size(chunk instanceof Consumable ? chunk.value : chunk);
                };
            }
        }
        super({
            start(controller) {
                return sink.start?.(controller);
            },
            write(chunk, controller) {
                return tryConsume(chunk, (chunk) => sink.write?.(chunk, controller));
            },
            abort(reason) {
                return sink.abort?.(reason);
            },
            close() {
                return sink.close?.();
            },
        }, wrappedStrategy);
    }
}

/**
 * Splits or combines buffers to specified size.
 */
class BufferCombiner {
    #capacity;
    #buffer;
    #offset;
    #available;
    constructor(size) {
        this.#capacity = size;
        this.#buffer = new Uint8Array(size);
        this.#offset = 0;
        this.#available = size;
    }
    /**
     * Pushes data to the combiner.
     * @param data The input data to be split or combined.
     * @returns
     * A generator that yields buffers of specified size.
     * It may yield the same buffer multiple times, consume the data before calling `next`.
     */
    *push(data) {
        let offset = 0;
        let available = data.length;
        if (this.#offset !== 0) {
            if (available >= this.#available) {
                this.#buffer.set(data.subarray(0, this.#available), this.#offset);
                offset += this.#available;
                available -= this.#available;
                yield this.#buffer;
                this.#offset = 0;
                this.#available = this.#capacity;
                if (available === 0) {
                    return;
                }
            }
            else {
                this.#buffer.set(data, this.#offset);
                this.#offset += available;
                this.#available -= available;
                return;
            }
        }
        while (available >= this.#capacity) {
            const end = offset + this.#capacity;
            yield data.subarray(offset, end);
            offset = end;
            available -= this.#capacity;
        }
        if (available > 0) {
            this.#buffer.set(data.subarray(offset), this.#offset);
            this.#offset += available;
            this.#available -= available;
        }
    }
    flush() {
        if (this.#offset === 0) {
            return undefined;
        }
        const output = this.#buffer.subarray(0, this.#offset);
        this.#offset = 0;
        this.#available = this.#capacity;
        return output;
    }
}
class DistributionStream extends TransformStream {
    constructor(size, combine = false) {
        const combiner = combine ? new BufferCombiner(size) : undefined;
        super({
            async transform(chunk, controller) {
                await tryConsume(chunk, async (chunk) => {
                    if (combiner) {
                        for (const buffer of combiner.push(chunk)) {
                            await Consumable.ReadableStream.enqueue(controller, buffer);
                        }
                    }
                    else {
                        let offset = 0;
                        let available = chunk.length;
                        while (available > 0) {
                            const end = offset + size;
                            await Consumable.ReadableStream.enqueue(controller, chunk.subarray(offset, end));
                            offset = end;
                            available -= size;
                        }
                    }
                });
            },
            flush(controller) {
                if (combiner) {
                    const data = combiner.flush();
                    if (data) {
                        controller.enqueue(data);
                    }
                }
            },
        });
    }
}

function getWrappedReadableStream(wrapper, controller) {
    if ("start" in wrapper) {
        return wrapper.start(controller);
    }
    else if (typeof wrapper === "function") {
        return wrapper(controller);
    }
    else {
        // Can't use `wrapper instanceof ReadableStream`
        // Because we want to be compatible with any ReadableStream-like objects
        return wrapper;
    }
}
/**
 * This class has multiple usages:
 *
 * 1. Get notified when the stream is cancelled or closed.
 * 2. Synchronously create a `ReadableStream` by asynchronously return another `ReadableStream`.
 * 3. Convert native `ReadableStream`s to polyfilled ones so they can `pipe` between.
 */
class WrapReadableStream extends ReadableStream$1 {
    readable;
    #reader;
    constructor(wrapper, strategy) {
        super({
            start: async (controller) => {
                const readable = await getWrappedReadableStream(wrapper, controller);
                // `start` is called in `super()`, so can't use `this` synchronously.
                // but it's fine after the first `await`
                this.readable = readable;
                this.#reader = this.readable.getReader();
            },
            pull: async (controller) => {
                const { done, value } = await this.#reader
                    .read()
                    .catch((e) => {
                    if ("error" in wrapper) {
                        wrapper.error(e);
                    }
                    throw e;
                });
                if (done) {
                    controller.close();
                    if ("close" in wrapper) {
                        await wrapper.close?.();
                    }
                }
                else {
                    controller.enqueue(value);
                }
            },
            cancel: async (reason) => {
                await this.#reader.cancel(reason);
                if ("cancel" in wrapper) {
                    await wrapper.cancel?.(reason);
                }
            },
        }, strategy);
    }
}

const NOOP$1 = () => {
    // no-op
};
/**
 * A factory for creating a duplex stream.
 *
 * It can create multiple `ReadableStream`s and `WritableStream`s,
 * when any of them is closed, all other streams will be closed as well.
 */
class DuplexStreamFactory {
    #readableControllers = [];
    #writers = [];
    #writableClosed = false;
    get writableClosed() {
        return this.#writableClosed;
    }
    #closed = new PromiseResolver();
    get closed() {
        return this.#closed.promise;
    }
    #options;
    constructor(options) {
        this.#options = options ?? {};
    }
    wrapReadable(readable, strategy) {
        return new WrapReadableStream({
            start: (controller) => {
                this.#readableControllers.push(controller);
                return readable;
            },
            cancel: async () => {
                // cancel means the local peer wants to close the connection.
                await this.close();
            },
            close: async () => {
                // stream end means the remote peer closed the connection first.
                await this.dispose();
            },
        }, strategy);
    }
    createWritable(stream) {
        const writer = stream.getWriter();
        this.#writers.push(writer);
        // `WritableStream` has no way to tell if the remote peer has closed the connection.
        // So it only triggers `close`.
        return new WritableStream({
            write: async (chunk) => {
                await writer.write(chunk);
            },
            abort: async (reason) => {
                await writer.abort(reason);
                await this.close();
            },
            close: async () => {
                // NOOP: the writer is already closed
                await writer.close().catch(NOOP$1);
                await this.close();
            },
        });
    }
    async close() {
        if (this.#writableClosed) {
            return;
        }
        this.#writableClosed = true;
        // Call `close` first, so it can still write data to `WritableStream`s.
        if ((await this.#options.close?.()) !== false) {
            // `close` can return `false` to disable automatic `dispose`.
            await this.dispose();
        }
        for (const writer of this.#writers) {
            // NOOP: the writer is already closed
            writer.close().catch(NOOP$1);
        }
    }
    async dispose() {
        this.#writableClosed = true;
        this.#closed.resolve();
        for (const controller of this.#readableControllers) {
            tryClose(controller);
        }
        await this.#options.dispose?.();
    }
}

const Global = globalThis;
const TextDecoderStream = Global.TextDecoderStream;

/**
 * Pipe `pair.readable` to `writable`, then returns `pair.writable`.
 *
 * This is the opposite of `ReadableStream#pipeThrough()`.
 *
 * @param writable The `WritableStream` to write to.
 * @param pair A `TransformStream` that converts chunks.
 * @returns `pair`'s `writable` stream.
 */
function pipeFrom(writable, pair) {
    const writer = pair.writable.getWriter();
    const pipe = pair.readable.pipeTo(writable);
    return new WritableStream({
        async write(chunk) {
            await writer.write(chunk);
        },
        async close() {
            await writer.close();
            await pipe;
        },
    });
}

class StructDeserializeStream extends BufferedTransformStream {
    constructor(struct) {
        super((stream) => {
            return struct.deserialize(stream);
        });
    }
}

class AutoDisposable {
    #disposables = [];
    constructor() {
        this.dispose = this.dispose.bind(this);
    }
    addDisposable(disposable) {
        this.#disposables.push(disposable);
        return disposable;
    }
    dispose() {
        for (const disposable of this.#disposables) {
            disposable.dispose();
        }
        this.#disposables = [];
    }
}

class EventEmitter {
    listeners = [];
    constructor() {
        this.event = this.event.bind(this);
    }
    addEventListener(info) {
        this.listeners.push(info);
        const remove = () => {
            const index = this.listeners.indexOf(info);
            if (index !== -1) {
                this.listeners.splice(index, 1);
            }
        };
        remove.dispose = remove;
        return remove;
    }
    event = (listener, thisArg, ...args) => {
        const info = {
            listener: listener,
            thisArg,
            args,
        };
        return this.addEventListener(info);
    };
    fire(e) {
        for (const info of this.listeners.slice()) {
            info.listener.call(info.thisArg, e, ...info.args);
        }
    }
    dispose() {
        this.listeners.length = 0;
    }
}

const Undefined = Symbol("undefined");
class StickyEventEmitter extends EventEmitter {
    #value = Undefined;
    addEventListener(info) {
        if (this.#value !== Undefined) {
            info.listener.call(info.thisArg, this.#value, ...info.args);
        }
        return super.addEventListener(info);
    }
    fire(e) {
        this.#value = e;
        super.fire(e);
    }
}

class AdbServiceBase extends AutoDisposable {
    #adb;
    get adb() {
        return this.#adb;
    }
    constructor(adb) {
        super();
        this.#adb = adb;
    }
}

const Version = struct({ version: u32 }, { littleEndian: true });
const AdbFrameBufferV1 = struct({
    bpp: u32,
    size: u32,
    width: u32,
    height: u32,
    red_offset: u32,
    red_length: u32,
    blue_offset: u32,
    blue_length: u32,
    green_offset: u32,
    green_length: u32,
    alpha_offset: u32,
    alpha_length: u32,
    data: buffer("size"),
}, { littleEndian: true });
const AdbFrameBufferV2 = struct({
    bpp: u32,
    colorSpace: u32,
    size: u32,
    width: u32,
    height: u32,
    red_offset: u32,
    red_length: u32,
    blue_offset: u32,
    blue_length: u32,
    green_offset: u32,
    green_length: u32,
    alpha_offset: u32,
    alpha_length: u32,
    data: buffer("size"),
}, { littleEndian: true });
class AdbFrameBufferError extends Error {
    constructor(message, options) {
        super(message, options);
    }
}
class AdbFrameBufferUnsupportedVersionError extends AdbFrameBufferError {
    constructor(version) {
        super(`Unsupported FrameBuffer version ${version}`);
    }
}
class AdbFrameBufferForbiddenError extends AdbFrameBufferError {
    constructor() {
        super("FrameBuffer is disabled by current app");
    }
}
async function framebuffer(adb) {
    const socket = await adb.createSocket("framebuffer:");
    const stream = new BufferedReadableStream(socket.readable);
    let version;
    try {
        ({ version } = await Version.deserialize(stream));
    }
    catch (e) {
        if (e instanceof StructEmptyError) {
            throw new AdbFrameBufferForbiddenError();
        }
        throw e;
    }
    switch (version) {
        case 1:
            // TODO: AdbFrameBuffer: does all v1 responses uses the same color space? Add it so the command returns same format for all versions.
            return await AdbFrameBufferV1.deserialize(stream);
        case 2:
            return await AdbFrameBufferV2.deserialize(stream);
        default:
            throw new AdbFrameBufferUnsupportedVersionError(version);
    }
}

// cspell: ignore bootloader
// cspell: ignore fastboot
// cspell: ignore keyevent
// cspell: ignore longpress
class AdbPower extends AdbServiceBase {
    reboot(mode = "") {
        return this.adb.createSocketAndWait(`reboot:${mode}`);
    }
    bootloader() {
        return this.reboot("bootloader");
    }
    fastboot() {
        return this.reboot("fastboot");
    }
    recovery() {
        return this.reboot("recovery");
    }
    sideload() {
        return this.reboot("sideload");
    }
    /**
     * Reboot to Qualcomm Emergency Download (EDL) Mode.
     *
     * Only works on some Qualcomm devices.
     */
    qualcommEdlMode() {
        return this.reboot("edl");
    }
    powerOff() {
        return this.adb.subprocess.noneProtocol.spawnWaitText(["reboot", "-p"]);
    }
    powerButton(longPress = false) {
        const args = ["input", "keyevent"];
        if (longPress) {
            args.push("--longpress");
        }
        args.push("POWER");
        return this.adb.subprocess.noneProtocol.spawnWaitText(args);
    }
    /**
     * Reboot to Samsung Odin download mode.
     *
     * Only works on Samsung devices.
     */
    samsungOdin() {
        return this.reboot("download");
    }
}

function toLocalUint8Array(value) {
    if (value.buffer instanceof ArrayBuffer) {
        return value;
    }
    const copy = new Uint8Array(value.length);
    copy.set(value);
    return copy;
}

class AutoResetEvent {
    #set;
    #queue = [];
    constructor(initialSet = false) {
        this.#set = initialSet;
    }
    wait() {
        if (!this.#set) {
            this.#set = true;
            if (this.#queue.length === 0) {
                return Promise.resolve();
            }
        }
        const resolver = new PromiseResolver();
        this.#queue.push(resolver);
        return resolver.promise;
    }
    notifyOne() {
        if (this.#queue.length !== 0) {
            this.#queue.pop().resolve();
        }
        else {
            this.#set = false;
        }
    }
    dispose() {
        for (const item of this.#queue) {
            item.reject(new Error("The AutoResetEvent has been disposed"));
        }
        this.#queue.length = 0;
    }
}

const [charToIndex, indexToChar, paddingChar] = /* #__PURE__ */ (() => {
    // Array is faster than object literal or `Map`
    const charToIndex = [];
    const indexToChar = [];
    const paddingChar = "=".charCodeAt(0);
    function addRange(start, end) {
        const charCodeStart = start.charCodeAt(0);
        const charCodeEnd = end.charCodeAt(0);
        for (let charCode = charCodeStart; charCode <= charCodeEnd; charCode += 1) {
            charToIndex[charCode] = indexToChar.length;
            indexToChar.push(charCode);
        }
    }
    addRange("A", "Z");
    addRange("a", "z");
    addRange("0", "9");
    addRange("+", "+");
    addRange("/", "/");
    return [charToIndex, indexToChar, paddingChar];
})();
/**
 * Calculate the required length of the output buffer for the given input length.
 *
 * @param inputLength Length of the input in bytes
 * @returns Length of the output in bytes
 */
function calculateBase64EncodedLength(inputLength) {
    const remainder = inputLength % 3;
    const paddingLength = remainder !== 0 ? 3 - remainder : 0;
    return [((inputLength + paddingLength) / 3) * 4, paddingLength];
}
function encodeBase64(input, output) {
    const [outputLength, paddingLength] = calculateBase64EncodedLength(input.length);
    if (!output) {
        output = new Uint8Array(outputLength);
        encodeForward(input, output, paddingLength);
        return output;
    }
    else {
        if (output.length < outputLength) {
            throw new TypeError("output buffer is too small");
        }
        output = output.subarray(0, outputLength);
        // When input and output are on same ArrayBuffer,
        // we check if it's possible to encode in-place.
        if (input.buffer !== output.buffer) {
            encodeForward(input, output, paddingLength);
        }
        else if (output.byteOffset + output.length - (paddingLength + 1) <=
            input.byteOffset + input.length) {
            // Output ends before input ends.
            // Can encode forwards, because writing output won't catch up with reading input.
            // The output end is subtracted by `(paddingLength + 1)` because
            // depending on padding length, it's possible to write 1-3 extra bytes after input ends.
            //
            // The following diagrams show how the last read from input and the last write to output
            // are not conflicting.
            //
            // spell: disable
            //
            // `paddingLength === 2` can write 3 extra bytes:
            //
            //   input:  | aaaaaabb |          |          |          |
            //   output: |  aaaaaa  |  bb0000  |    =     |    =     |
            //
            // `paddingLength === 1` can write 2 extra bytes:
            //
            //   input:  | aaaaaabb | bbbbcccc |          |          |
            //   output: |  aaaaaa  |  bbbbbb  |  cccc00  |    =     |
            //
            // `paddingLength === 0` can write 1 extra byte:
            //
            //   input:  | aaaaaabb | bbbbcccc | ccdddddd |          |
            //   output: |  aaaaaa  |  bbbbbb  |  cccccc  |  dddddd  |
            //
            // spell: enable
            encodeForward(input, output, paddingLength);
        }
        else if (output.byteOffset >= input.byteOffset - 1) {
            // Output starts after input starts
            // So in backwards, writing output won't catch up with reading input.
            // The input start is subtracted by `1`, Because as the first 3 bytes becomes 4 bytes,
            // it's possible to write 1 extra byte before input starts.
            // spell: disable-next-line
            //   input:  |          | aaaaaabb | bbbbcccc | ccdddddd |
            //   output: |  aaaaaa  |  bbbbbb  |  cccccc  |  dddddd  |
            // Must encode backwards.
            encodeBackward(input, output, paddingLength);
        }
        else {
            // Input is in the middle of output,
            // It's not possible to read either the first or the last three bytes
            // before they are overwritten by the output.
            throw new TypeError("input and output cannot overlap");
        }
        return outputLength;
    }
}
function encodeForward(input, output, paddingLength) {
    let inputIndex = 0;
    let outputIndex = 0;
    while (inputIndex < input.length - 2) {
        /* cspell: disable-next-line */
        // aaaaaabb
        const x = input[inputIndex];
        inputIndex += 1;
        /* cspell: disable-next-line */
        // bbbbcccc
        const y = input[inputIndex];
        inputIndex += 1;
        /* cspell: disable-next-line */
        // ccdddddd
        const z = input[inputIndex];
        inputIndex += 1;
        output[outputIndex] = indexToChar[x >> 2];
        outputIndex += 1;
        output[outputIndex] = indexToChar[((x & 0b11) << 4) | (y >> 4)];
        outputIndex += 1;
        output[outputIndex] = indexToChar[((y & 0b1111) << 2) | (z >> 6)];
        outputIndex += 1;
        output[outputIndex] = indexToChar[z & 0b111111];
        outputIndex += 1;
    }
    if (paddingLength === 2) {
        /* cspell: disable-next-line */
        // aaaaaabb
        const x = input[inputIndex];
        output[outputIndex] = indexToChar[x >> 2];
        outputIndex += 1;
        output[outputIndex] = indexToChar[(x & 0b11) << 4];
        outputIndex += 1;
        output[outputIndex] = paddingChar;
        outputIndex += 1;
        output[outputIndex] = paddingChar;
    }
    else if (paddingLength === 1) {
        /* cspell: disable-next-line */
        // aaaaaabb
        const x = input[inputIndex];
        inputIndex += 1;
        /* cspell: disable-next-line */
        // bbbbcccc
        const y = input[inputIndex];
        output[outputIndex] = indexToChar[x >> 2];
        outputIndex += 1;
        output[outputIndex] = indexToChar[((x & 0b11) << 4) | (y >> 4)];
        outputIndex += 1;
        output[outputIndex] = indexToChar[(y & 0b1111) << 2];
        outputIndex += 1;
        output[outputIndex] = paddingChar;
    }
}
function encodeBackward(input, output, paddingLength) {
    let inputIndex = input.length - 1;
    let outputIndex = output.length - 1;
    if (paddingLength === 2) {
        /* cspell: disable-next-line */
        // aaaaaabb
        const x = input[inputIndex];
        inputIndex -= 1;
        output[outputIndex] = paddingChar;
        outputIndex -= 1;
        output[outputIndex] = paddingChar;
        outputIndex -= 1;
        output[outputIndex] = indexToChar[(x & 0b11) << 4];
        outputIndex -= 1;
        output[outputIndex] = indexToChar[x >> 2];
        outputIndex -= 1;
    }
    else if (paddingLength === 1) {
        /* cspell: disable-next-line */
        // bbbbcccc
        const y = input[inputIndex];
        inputIndex -= 1;
        /* cspell: disable-next-line */
        // aaaaaabb
        const x = input[inputIndex];
        inputIndex -= 1;
        output[outputIndex] = paddingChar;
        outputIndex -= 1;
        output[outputIndex] = indexToChar[(y & 0b1111) << 2];
        outputIndex -= 1;
        output[outputIndex] = indexToChar[((x & 0b11) << 4) | (y >> 4)];
        outputIndex -= 1;
        output[outputIndex] = indexToChar[x >> 2];
        outputIndex -= 1;
    }
    while (inputIndex >= 0) {
        /* cspell: disable-next-line */
        // ccdddddd
        const z = input[inputIndex];
        inputIndex -= 1;
        /* cspell: disable-next-line */
        // bbbbcccc
        const y = input[inputIndex];
        inputIndex -= 1;
        /* cspell: disable-next-line */
        // aaaaaabb
        const x = input[inputIndex];
        inputIndex -= 1;
        output[outputIndex] = indexToChar[z & 0b111111];
        outputIndex -= 1;
        output[outputIndex] = indexToChar[((y & 0b1111) << 2) | (z >> 6)];
        outputIndex -= 1;
        output[outputIndex] = indexToChar[((x & 0b11) << 4) | (y >> 4)];
        outputIndex -= 1;
        output[outputIndex] = indexToChar[x >> 2];
        outputIndex -= 1;
    }
}

function hexCharToNumber(char) {
    if (char < 48) {
        throw new TypeError(`Invalid hex char ${char}`);
    }
    if (char < 58) {
        // 0-9
        return char - 48;
    }
    if (char < 65) {
        throw new TypeError(`Invalid hex char ${char}`);
    }
    if (char < 71) {
        // A-F
        return char - 55;
    }
    if (char < 97) {
        throw new TypeError(`Invalid hex char ${char}`);
    }
    if (char < 103) {
        // a-f
        return char - 87;
    }
    throw new TypeError(`Invalid hex char ${char}`);
}
// It's 22x faster than converting `data` to string then `Number.parseInt`
// https://jsbench.me/dglha94ozl/1
function hexToNumber(data) {
    let result = 0;
    for (let i = 0; i < data.length; i += 1) {
        result = (result << 4) | hexCharToNumber(data[i]);
    }
    return result;
}

/* #__NO_SIDE_EFFECTS__ */
const NOOP = () => {
    // no-op
};
/**
 * When used in `Promise#catch`, means the promise should never throw errors.
 * An explicit way to suppress ESLint floating promise warnings.
 */
function unreachable(...args) {
    // Trigger runtime's unhandled rejection event.
    throw new Error("Unreachable. Arguments:\n" + args.join("\n"));
}

function sequenceEqual(a, b) {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}

// cspell: ignore killforward
const AdbReverseStringResponse = struct({
    length: string(4),
    content: string({
        field: "length",
        convert(value) {
            return Number.parseInt(value, 16);
        },
        back(value) {
            return value.toString(16).padStart(4, "0");
        },
    }),
}, { littleEndian: true });
class AdbReverseError extends Error {
    constructor(message) {
        super(message);
    }
}
class AdbReverseNotSupportedError extends AdbReverseError {
    constructor() {
        super("ADB reverse tunnel is not supported on this device when connected wirelessly.");
    }
}
const AdbReverseErrorResponse = extend(AdbReverseStringResponse, {}, {
    postDeserialize(value) {
        // https://issuetracker.google.com/issues/37066218
        // ADB on Android <9 can't create reverse tunnels when connected wirelessly (ADB over Wi-Fi),
        // and returns this confusing "more than one device/emulator" error.
        if (value.content === "more than one device/emulator") {
            throw new AdbReverseNotSupportedError();
        }
        else {
            throw new AdbReverseError(value.content);
        }
    },
});
// Like `hexToNumber`, it's much faster than first converting `buffer` to a string
function decimalToNumber(buffer) {
    let value = 0;
    for (const byte of buffer) {
        // Like `parseInt`, return when it encounters a non-digit character
        if (byte < 48 || byte > 57) {
            return value;
        }
        value = value * 10 + byte - 48;
    }
    return value;
}
const OKAY = encodeUtf8("OKAY");
class AdbReverseService extends AdbServiceBase {
    #deviceAddressToLocalAddress = new Map();
    async createBufferedStream(service) {
        const socket = await this.adb.createSocket(service);
        return new BufferedReadableStream(socket.readable);
    }
    async sendRequest(service) {
        const stream = await this.createBufferedStream(service);
        const response = await stream.readExactly(4);
        if (!sequenceEqual(response, OKAY)) {
            await AdbReverseErrorResponse.deserialize(stream);
        }
        return stream;
    }
    /**
     * Get a list of all reverse port forwarding on the device.
     */
    async list() {
        const stream = await this.createBufferedStream("reverse:list-forward");
        const response = await AdbReverseStringResponse.deserialize(stream);
        return response.content
            .split("\n")
            .filter((line) => !!line)
            .map((line) => {
            const [deviceSerial, localName, remoteName] = line.split(" ");
            return { deviceSerial, localName, remoteName };
        });
        // No need to close the stream, device will close it
    }
    /**
     * Add a reverse port forwarding for a program that already listens on a port.
     */
    async addExternal(deviceAddress, localAddress) {
        const stream = await this.sendRequest(`reverse:forward:${deviceAddress};${localAddress}`);
        // `tcp:0` tells the device to pick an available port.
        // On Android >=8, device will respond with the selected port for all `tcp:` requests.
        if (deviceAddress.startsWith("tcp:")) {
            const position = stream.position;
            try {
                const length = hexToNumber(await stream.readExactly(4));
                const port = decimalToNumber(await stream.readExactly(length));
                deviceAddress = `tcp:${port}`;
            }
            catch (e) {
                if (e instanceof ExactReadableEndedError &&
                    stream.position === position) ;
                else {
                    throw e;
                }
            }
        }
        return deviceAddress;
    }
    /**
     * Add a reverse port forwarding.
     */
    async add(deviceAddress, handler, localAddress) {
        localAddress = await this.adb.transport.addReverseTunnel(handler, localAddress);
        try {
            deviceAddress = await this.addExternal(deviceAddress, localAddress);
            this.#deviceAddressToLocalAddress.set(deviceAddress, localAddress);
            return deviceAddress;
        }
        catch (e) {
            await this.adb.transport.removeReverseTunnel(localAddress);
            throw e;
        }
    }
    /**
     * Remove a reverse port forwarding.
     */
    async remove(deviceAddress) {
        const localAddress = this.#deviceAddressToLocalAddress.get(deviceAddress);
        if (localAddress) {
            await this.adb.transport.removeReverseTunnel(localAddress);
        }
        await this.sendRequest(`reverse:killforward:${deviceAddress}`);
        // No need to close the stream, device will close it
    }
    /**
     * Remove all reverse port forwarding, including the ones added by other programs.
     */
    async removeAll() {
        await this.adb.transport.clearReverseTunnels();
        this.#deviceAddressToLocalAddress.clear();
        await this.sendRequest(`reverse:killforward-all`);
        // No need to close the stream, device will close it
    }
}

class AdbNoneProtocolProcessImpl {
    #socket;
    get stdin() {
        return this.#socket.writable;
    }
    get output() {
        return this.#socket.readable;
    }
    #exited;
    get exited() {
        return this.#exited;
    }
    constructor(socket, signal) {
        this.#socket = socket;
        if (signal) {
            // `signal` won't affect `this.output`
            // So remaining data can still be read
            // (call `controller.error` will discard all pending data)
            const exited = new PromiseResolver();
            this.#socket.closed.then(() => exited.resolve(undefined), (e) => exited.reject(e));
            signal.addEventListener("abort", () => {
                exited.reject(signal.reason);
                this.#socket.close();
            });
            this.#exited = exited.promise;
        }
        else {
            this.#exited = this.#socket.closed;
        }
    }
    kill() {
        return this.#socket.close();
    }
}

class AdbNoneProtocolPtyProcess {
    #socket;
    #writer;
    #input;
    get input() {
        return this.#input;
    }
    get output() {
        return this.#socket.readable;
    }
    get exited() {
        return this.#socket.closed;
    }
    constructor(socket) {
        this.#socket = socket;
        this.#writer = this.#socket.writable.getWriter();
        this.#input = new MaybeConsumableWritableStream({
            write: (chunk) => this.#writer.write(chunk),
        });
    }
    sigint() {
        return this.#writer.write(new Uint8Array([0x03]));
    }
    kill() {
        return this.#socket.close();
    }
}

function escapeArg(s) {
    let result = "";
    result += `'`;
    let base = 0;
    while (true) {
        const found = s.indexOf(`'`, base);
        if (found === -1) {
            result += s.substring(base);
            break;
        }
        result += s.substring(base, found);
        // a'b becomes a'\'b (the backslash is not a escape character)
        result += String.raw `'\''`;
        base = found + 1;
    }
    result += `'`;
    return result;
}
function splitCommand(command) {
    const result = [];
    let quote;
    let isEscaped = false;
    let start = 0;
    for (let i = 0, len = command.length; i < len; i += 1) {
        if (isEscaped) {
            isEscaped = false;
            continue;
        }
        const char = command.charAt(i);
        switch (char) {
            case " ":
                if (!quote && i !== start) {
                    result.push(command.substring(start, i));
                    start = i + 1;
                }
                break;
            case "'":
            case '"':
                if (!quote) {
                    quote = char;
                }
                else if (char === quote) {
                    quote = undefined;
                }
                break;
            case "\\":
                isEscaped = true;
                break;
        }
    }
    if (start < command.length) {
        result.push(command.substring(start));
    }
    return result;
}

class AdbNoneProtocolSpawner {
    #spawn;
    constructor(spawn) {
        this.#spawn = spawn;
    }
    spawn(command, signal) {
        signal?.throwIfAborted();
        if (typeof command === "string") {
            command = splitCommand(command);
        }
        return this.#spawn(command, signal);
    }
    async spawnWait(command) {
        const process = await this.spawn(command);
        return await process.output.pipeThrough(new ConcatBufferStream());
    }
    async spawnWaitText(command) {
        const process = await this.spawn(command);
        return await process.output
            .pipeThrough(new TextDecoderStream())
            .pipeThrough(new ConcatStringStream());
    }
}

class AdbNoneProtocolSubprocessService extends AdbNoneProtocolSpawner {
    #adb;
    get adb() {
        return this.#adb;
    }
    constructor(adb) {
        super(async (command, signal) => {
            // `shell,raw:${command}` also triggers raw mode,
            // But is not supported on Android version <7.
            const socket = await this.#adb.createSocket(`exec:${command.join(" ")}`);
            if (signal?.aborted) {
                await socket.close();
                throw signal.reason;
            }
            return new AdbNoneProtocolProcessImpl(socket, signal);
        });
        this.#adb = adb;
    }
    async pty(command) {
        if (command === undefined) {
            command = "";
        }
        else if (Array.isArray(command)) {
            command = command.join(" ");
        }
        return new AdbNoneProtocolPtyProcess(
        // https://github.com/microsoft/typescript/issues/17002
        await this.#adb.createSocket(`shell:${command}`));
    }
}

// The order follows
// https://cs.android.com/android/platform/superproject/+/master:packages/modules/adb/transport.cpp;l=77;drc=6d14d35d0241f6fee145f8e54ffd77252e8d29fd
const AdbFeature = {
    ShellV2: "shell_v2",
    Cmd: "cmd",
    StatV2: "stat_v2",
    ListV2: "ls_v2",
    FixedPushMkdir: "fixed_push_mkdir",
    Abb: "abb",
    AbbExec: "abb_exec",
    SendReceiveV2: "sendrecv_v2",
    DelayedAck: "delayed_ack",
};

const AdbShellProtocolId = {
    Stdin: 0,
    Stdout: 1,
    Stderr: 2,
    Exit: 3,
    CloseStdin: 4,
    WindowSizeChange: 5,
};
// This packet format is used in both directions.
const AdbShellProtocolPacket = struct({
    id: u8(),
    data: buffer(u32),
}, { littleEndian: true });

class AdbShellProtocolProcessImpl {
    #socket;
    #writer;
    #stdin;
    get stdin() {
        return this.#stdin;
    }
    #stdout;
    get stdout() {
        return this.#stdout;
    }
    #stderr;
    get stderr() {
        return this.#stderr;
    }
    #exited;
    get exited() {
        return this.#exited;
    }
    constructor(socket, signal) {
        this.#socket = socket;
        let stdoutController;
        let stderrController;
        this.#stdout = new PushReadableStream((controller) => {
            stdoutController = controller;
        });
        this.#stderr = new PushReadableStream((controller) => {
            stderrController = controller;
        });
        const exited = new PromiseResolver();
        this.#exited = exited.promise;
        socket.readable
            .pipeThrough(new StructDeserializeStream(AdbShellProtocolPacket))
            .pipeTo(new WritableStream({
            write: async (chunk) => {
                switch (chunk.id) {
                    case AdbShellProtocolId.Exit:
                        exited.resolve(chunk.data[0]);
                        break;
                    case AdbShellProtocolId.Stdout:
                        await stdoutController.enqueue(chunk.data);
                        break;
                    case AdbShellProtocolId.Stderr:
                        await stderrController.enqueue(chunk.data);
                        break;
                }
            },
        }))
            .then(() => {
            stdoutController.close();
            stderrController.close();
            // If `exited` has already settled, this will be a no-op
            exited.reject(new Error("Socket ended without exit message"));
        }, (e) => {
            stdoutController.error(e);
            stderrController.error(e);
            // If `exited` has already settled, this will be a no-op
            exited.reject(e);
        });
        if (signal) {
            // `signal` won't affect `this.stdout` and `this.stderr`
            // So remaining data can still be read
            // (call `controller.error` will discard all pending data)
            signal.addEventListener("abort", () => {
                exited.reject(signal.reason);
                this.#socket.close();
            });
        }
        this.#writer = this.#socket.writable.getWriter();
        this.#stdin = new MaybeConsumableWritableStream({
            write: async (chunk) => {
                await this.#writer.write(AdbShellProtocolPacket.serialize({
                    id: AdbShellProtocolId.Stdin,
                    data: chunk,
                }));
            },
            close: () => 
            // Only shell protocol + raw mode supports closing stdin
            this.#writer.write(AdbShellProtocolPacket.serialize({
                id: AdbShellProtocolId.CloseStdin,
                data: EmptyUint8Array,
            })),
        });
    }
    kill() {
        return this.#socket.close();
    }
}

class AdbShellProtocolPtyProcess {
    #socket;
    #writer;
    #input;
    get input() {
        return this.#input;
    }
    #stdout;
    get output() {
        return this.#stdout;
    }
    #exited = new PromiseResolver();
    get exited() {
        return this.#exited.promise;
    }
    constructor(socket) {
        this.#socket = socket;
        let stdoutController;
        this.#stdout = new PushReadableStream((controller) => {
            stdoutController = controller;
        });
        socket.readable
            .pipeThrough(new StructDeserializeStream(AdbShellProtocolPacket))
            .pipeTo(new WritableStream({
            write: async (chunk) => {
                switch (chunk.id) {
                    case AdbShellProtocolId.Exit:
                        this.#exited.resolve(chunk.data[0]);
                        break;
                    case AdbShellProtocolId.Stdout:
                        await stdoutController.enqueue(chunk.data);
                        break;
                }
            },
        }))
            .then(() => {
            stdoutController.close();
            // If `#exit` has already resolved, this will be a no-op
            this.#exited.reject(new Error("Socket ended without exit message"));
        }, (e) => {
            stdoutController.error(e);
            // If `#exit` has already resolved, this will be a no-op
            this.#exited.reject(e);
        });
        this.#writer = this.#socket.writable.getWriter();
        this.#input = new MaybeConsumableWritableStream({
            write: (chunk) => this.#writeStdin(chunk),
        });
    }
    #writeStdin(chunk) {
        return this.#writer.write(AdbShellProtocolPacket.serialize({
            id: AdbShellProtocolId.Stdin,
            data: chunk,
        }));
    }
    async resize(rows, cols) {
        await this.#writer.write(AdbShellProtocolPacket.serialize({
            id: AdbShellProtocolId.WindowSizeChange,
            // The "correct" format is `${rows}x${cols},${x_pixels}x${y_pixels}`
            // However, according to https://linux.die.net/man/4/tty_ioctl
            // `x_pixels` and `y_pixels` are unused, so always sending `0` should be fine.
            data: encodeUtf8(`${rows}x${cols},0x0\0`),
        }));
    }
    sigint() {
        return this.#writeStdin(new Uint8Array([0x03]));
    }
    kill() {
        return this.#socket.close();
    }
}

class AdbShellProtocolSpawner {
    #spawn;
    constructor(spawn) {
        this.#spawn = spawn;
    }
    spawn(command, signal) {
        signal?.throwIfAborted();
        if (typeof command === "string") {
            command = splitCommand(command);
        }
        return this.#spawn(command, signal);
    }
    async spawnWait(command) {
        const process = await this.spawn(command);
        const [stdout, stderr, exitCode] = await Promise.all([
            process.stdout.pipeThrough(new ConcatBufferStream()),
            process.stderr.pipeThrough(new ConcatBufferStream()),
            process.exited,
        ]);
        return { stdout, stderr, exitCode };
    }
    async spawnWaitText(command) {
        const process = await this.spawn(command);
        const [stdout, stderr, exitCode] = await Promise.all([
            process.stdout
                .pipeThrough(new TextDecoderStream())
                .pipeThrough(new ConcatStringStream()),
            process.stderr
                .pipeThrough(new TextDecoderStream())
                .pipeThrough(new ConcatStringStream()),
            process.exited,
        ]);
        return { stdout, stderr, exitCode };
    }
}

class AdbShellProtocolSubprocessService extends AdbShellProtocolSpawner {
    #adb;
    get adb() {
        return this.#adb;
    }
    get isSupported() {
        return this.#adb.canUseFeature(AdbFeature.ShellV2);
    }
    constructor(adb) {
        super(async (command, signal) => {
            const socket = await this.#adb.createSocket(`shell,v2,raw:${command.join(" ")}`);
            if (signal?.aborted) {
                await socket.close();
                throw signal.reason;
            }
            return new AdbShellProtocolProcessImpl(socket, signal);
        });
        this.#adb = adb;
    }
    async pty(options) {
        let service = "shell,v2,pty";
        if (options?.terminalType) {
            service += `,TERM=` + options.terminalType;
        }
        service += ":";
        if (options) {
            if (typeof options.command === "string") {
                service += options.command;
            }
            else if (Array.isArray(options.command)) {
                service += options.command.join(" ");
            }
        }
        return new AdbShellProtocolPtyProcess(await this.#adb.createSocket(service));
    }
}

class AdbSubprocessService {
    #adb;
    get adb() {
        return this.#adb;
    }
    #noneProtocol;
    get noneProtocol() {
        return this.#noneProtocol;
    }
    #shellProtocol;
    get shellProtocol() {
        return this.#shellProtocol;
    }
    constructor(adb) {
        this.#adb = adb;
        this.#noneProtocol = new AdbNoneProtocolSubprocessService(adb);
        if (adb.canUseFeature(AdbFeature.ShellV2)) {
            this.#shellProtocol = new AdbShellProtocolSubprocessService(adb);
        }
    }
}

function encodeAsciiUnchecked(value) {
    const result = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i += 1) {
        result[i] = value.charCodeAt(i);
    }
    return result;
}
/**
 * Encode ID to numbers for faster comparison
 * @param value A 4-character string
 * @returns A 32-bit integer by encoding the string as little-endian
 *
 * #__NO_SIDE_EFFECTS__
 */
function adbSyncEncodeId(value) {
    const buffer = encodeAsciiUnchecked(value);
    return getUint32LittleEndian(buffer, 0);
}
const AdbSyncResponseId = {
    Entry: adbSyncEncodeId("DENT"),
    Entry2: adbSyncEncodeId("DNT2"),
    Lstat: adbSyncEncodeId("STAT"),
    Stat: adbSyncEncodeId("STA2"),
    Lstat2: adbSyncEncodeId("LST2"),
    Done: adbSyncEncodeId("DONE"),
    Data: adbSyncEncodeId("DATA"),
    Ok: adbSyncEncodeId("OKAY"),
    Fail: adbSyncEncodeId("FAIL"),
};
class AdbSyncError extends Error {
}
const AdbSyncFailResponse = struct({ message: string(u32) }, {
    littleEndian: true,
    postDeserialize(value) {
        throw new AdbSyncError(value.message);
    },
});
async function adbSyncReadResponse(stream, id, type) {
    if (typeof id === "string") {
        id = adbSyncEncodeId(id);
    }
    const buffer = await stream.readExactly(4);
    switch (getUint32LittleEndian(buffer, 0)) {
        case AdbSyncResponseId.Fail:
            await AdbSyncFailResponse.deserialize(stream);
            throw new Error("Unreachable");
        case id:
            return await type.deserialize(stream);
        default:
            throw new Error(`Expected '${id}', but got '${decodeUtf8(buffer)}'`);
    }
}
async function* adbSyncReadResponses(stream, id, type) {
    if (typeof id === "string") {
        id = adbSyncEncodeId(id);
    }
    while (true) {
        const buffer = await stream.readExactly(4);
        switch (getUint32LittleEndian(buffer, 0)) {
            case AdbSyncResponseId.Fail:
                await AdbSyncFailResponse.deserialize(stream);
                unreachable();
            case AdbSyncResponseId.Done:
                // `DONE` responses' size are always same as the request's normal response.
                //
                // For example, `DONE` responses for `LIST` requests are 16 bytes (same as `DENT` responses),
                // but `DONE` responses for `STAT` requests are 12 bytes (same as `STAT` responses).
                await stream.readExactly(type.size);
                return;
            case id:
                yield await type.deserialize(stream);
                break;
            default:
                throw new Error(`Expected '${id}' or '${AdbSyncResponseId.Done}', but got '${decodeUtf8(buffer)}'`);
        }
    }
}

const AdbSyncRequestId = {
    List: adbSyncEncodeId("LIST"),
    ListV2: adbSyncEncodeId("LIS2"),
    Send: adbSyncEncodeId("SEND"),
    SendV2: adbSyncEncodeId("SND2"),
    Lstat: adbSyncEncodeId("STAT"),
    Stat: adbSyncEncodeId("STA2"),
    LstatV2: adbSyncEncodeId("LST2"),
    Data: adbSyncEncodeId("DATA"),
    Done: adbSyncEncodeId("DONE"),
    Receive: adbSyncEncodeId("RECV"),
};
const AdbSyncNumberRequest = struct({ id: u32, arg: u32 }, { littleEndian: true });
async function adbSyncWriteRequest(writable, id, value) {
    if (typeof id === "string") {
        id = adbSyncEncodeId(id);
    }
    if (typeof value === "number") {
        await writable.write(AdbSyncNumberRequest.serialize({ id, arg: value }));
        return;
    }
    if (typeof value === "string") {
        value = encodeUtf8(value);
    }
    // `writable` is buffered, it copies inputs to an internal buffer,
    // so don't concatenate headers and data here, that will be an unnecessary copy.
    await writable.write(AdbSyncNumberRequest.serialize({ id, arg: value.length }));
    await writable.write(value);
}

// https://github.com/python/cpython/blob/4e581d64b8aff3e2eda99b12f080c877bb78dfca/Lib/stat.py#L36
const LinuxFileType = {
    File: 0o10};
const AdbSyncLstatResponse = struct({ mode: u32, size: u32, mtime: u32 }, {
    littleEndian: true,
    extra: {
        get type() {
            return (this.mode >> 12);
        },
        get permission() {
            return this.mode & 0b00001111_11111111;
        },
    },
    postDeserialize(value) {
        if (value.mode === 0 && value.size === 0 && value.mtime === 0) {
            throw new Error("lstat error");
        }
        return value;
    },
});
const AdbSyncStatErrorCode = {
    SUCCESS: 0,
    EACCES: 13,
    EEXIST: 17,
    EFAULT: 14,
    EFBIG: 27,
    EINTR: 4,
    EINVAL: 22,
    EIO: 5,
    EISDIR: 21,
    ELOOP: 40,
    EMFILE: 24,
    ENAMETOOLONG: 36,
    ENFILE: 23,
    ENOENT: 2,
    ENOMEM: 12,
    ENOSPC: 28,
    ENOTDIR: 20,
    EOVERFLOW: 75,
    EPERM: 1,
    EROFS: 30,
    ETXTBSY: 26,
};
const AdbSyncStatErrorName = /* #__PURE__ */ (() => Object.fromEntries(Object.entries(AdbSyncStatErrorCode).map(([key, value]) => [
    value,
    key,
])))();
const AdbSyncStatResponse = struct({
    error: u32(),
    dev: u64,
    ino: u64,
    mode: u32,
    nlink: u32,
    uid: u32,
    gid: u32,
    size: u64,
    atime: u64,
    mtime: u64,
    ctime: u64,
}, {
    littleEndian: true,
    extra: {
        get type() {
            return (this.mode >> 12);
        },
        get permission() {
            return this.mode & 0b00001111_11111111;
        },
    },
    postDeserialize(value) {
        if (value.error) {
            throw new Error(AdbSyncStatErrorName[value.error]);
        }
        return value;
    },
});
async function adbSyncLstat(socket, path, v2) {
    const locked = await socket.lock();
    try {
        if (v2) {
            await adbSyncWriteRequest(locked, AdbSyncRequestId.LstatV2, path);
            return await adbSyncReadResponse(locked, AdbSyncResponseId.Lstat2, AdbSyncStatResponse);
        }
        else {
            await adbSyncWriteRequest(locked, AdbSyncRequestId.Lstat, path);
            const response = await adbSyncReadResponse(locked, AdbSyncResponseId.Lstat, AdbSyncLstatResponse);
            return {
                mode: response.mode,
                // Convert to `BigInt` to make it compatible with `AdbSyncStatResponse`
                size: BigInt(response.size),
                mtime: BigInt(response.mtime),
                get type() {
                    return response.type;
                },
                get permission() {
                    return response.permission;
                },
            };
        }
    }
    finally {
        locked.release();
    }
}
async function adbSyncStat(socket, path) {
    const locked = await socket.lock();
    try {
        await adbSyncWriteRequest(locked, AdbSyncRequestId.Stat, path);
        return await adbSyncReadResponse(locked, AdbSyncResponseId.Stat, AdbSyncStatResponse);
    }
    finally {
        locked.release();
    }
}

const AdbSyncEntryResponse = extend(AdbSyncLstatResponse, {
    name: string(u32),
});
const AdbSyncEntry2Response = extend(AdbSyncStatResponse, {
    name: string(u32),
});
async function* adbSyncOpenDirV2(socket, path) {
    const locked = await socket.lock();
    try {
        await adbSyncWriteRequest(locked, AdbSyncRequestId.ListV2, path);
        for await (const item of adbSyncReadResponses(locked, AdbSyncResponseId.Entry2, AdbSyncEntry2Response)) {
            // `LST2` can return error codes for failed `lstat` calls.
            // `LIST` just ignores them.
            // But they only contain `name` so still pretty useless.
            if (item.error !== AdbSyncStatErrorCode.SUCCESS) {
                continue;
            }
            yield item;
        }
    }
    finally {
        locked.release();
    }
}
async function* adbSyncOpenDirV1(socket, path) {
    const locked = await socket.lock();
    try {
        await adbSyncWriteRequest(locked, AdbSyncRequestId.List, path);
        for await (const item of adbSyncReadResponses(locked, AdbSyncResponseId.Entry, AdbSyncEntryResponse)) {
            yield item;
        }
    }
    finally {
        locked.release();
    }
}
async function* adbSyncOpenDir(socket, path, v2) {
    if (v2) {
        yield* adbSyncOpenDirV2(socket, path);
    }
    else {
        for await (const item of adbSyncOpenDirV1(socket, path)) {
            // Convert to same format as `AdbSyncEntry2Response` for easier consumption.
            // However it will add some overhead.
            yield {
                mode: item.mode,
                size: BigInt(item.size),
                mtime: BigInt(item.mtime),
                get type() {
                    return item.type;
                },
                get permission() {
                    return item.permission;
                },
                name: item.name,
            };
        }
    }
}

const AdbSyncDataResponse = struct({ data: buffer(u32) }, { littleEndian: true });
async function* adbSyncPullGenerator(socket, path) {
    const locked = await socket.lock();
    let done = false;
    try {
        await adbSyncWriteRequest(locked, AdbSyncRequestId.Receive, path);
        for await (const packet of adbSyncReadResponses(locked, AdbSyncResponseId.Data, AdbSyncDataResponse)) {
            yield packet.data;
        }
        done = true;
    }
    catch (e) {
        done = true;
        throw e;
    }
    finally {
        if (!done) {
            // sync pull can't be cancelled, so we have to read all data
            for await (const packet of adbSyncReadResponses(locked, AdbSyncResponseId.Data, AdbSyncDataResponse)) {
            }
        }
        locked.release();
    }
}
function adbSyncPull(socket, path) {
    return ReadableStream$1.from(adbSyncPullGenerator(socket, path));
}

const ADB_SYNC_MAX_PACKET_SIZE = 64 * 1024;
const AdbSyncOkResponse = struct({ unused: u32 }, { littleEndian: true });
async function pipeFileData(locked, file, packetSize, mtime) {
    // Read and write in parallel,
    // allow error response to abort the write.
    const abortController = new AbortController();
    file.pipeThrough(new DistributionStream(packetSize, true))
        .pipeTo(new MaybeConsumableWritableStream({
        write(chunk) {
            return adbSyncWriteRequest(locked, AdbSyncRequestId.Data, chunk);
        },
    }), { signal: abortController.signal })
        .then(async () => {
        await adbSyncWriteRequest(locked, AdbSyncRequestId.Done, mtime);
        await locked.flush();
    }, NOOP);
    await adbSyncReadResponse(locked, AdbSyncResponseId.Ok, AdbSyncOkResponse).catch((e) => {
        abortController.abort();
        throw e;
    });
}
async function adbSyncPushV1({ socket, filename, file, type = LinuxFileType.File, permission = 0o666, mtime = (Date.now() / 1000) | 0, packetSize = ADB_SYNC_MAX_PACKET_SIZE, }) {
    const locked = await socket.lock();
    try {
        const mode = (type << 12) | permission;
        const pathAndMode = `${filename},${mode.toString()}`;
        await adbSyncWriteRequest(locked, AdbSyncRequestId.Send, pathAndMode);
        await pipeFileData(locked, file, packetSize, mtime);
    }
    finally {
        locked.release();
    }
}
const AdbSyncSendV2Flags = {
    None: 0,
    Brotli: 1,
    /**
     * 2
     */
    Lz4: 1 << 1,
    /**
     * 4
     */
    Zstd: 1 << 2,
    DryRun: 0x80000000,
};
const AdbSyncSendV2Request = struct({ id: u32, mode: u32, flags: u32() }, { littleEndian: true });
async function adbSyncPushV2({ socket, filename, file, type = LinuxFileType.File, permission = 0o666, mtime = (Date.now() / 1000) | 0, packetSize = ADB_SYNC_MAX_PACKET_SIZE, dryRun = false, }) {
    const locked = await socket.lock();
    try {
        await adbSyncWriteRequest(locked, AdbSyncRequestId.SendV2, filename);
        const mode = (type << 12) | permission;
        let flags = AdbSyncSendV2Flags.None;
        if (dryRun) {
            flags |= AdbSyncSendV2Flags.DryRun;
        }
        await locked.write(AdbSyncSendV2Request.serialize({
            id: AdbSyncRequestId.SendV2,
            mode,
            flags,
        }));
        await pipeFileData(locked, file, packetSize, mtime);
    }
    finally {
        locked.release();
    }
}
function adbSyncPush(options) {
    if (options.v2) {
        return adbSyncPushV2(options);
    }
    if (options.dryRun) {
        throw new Error("dryRun is not supported in v1");
    }
    return adbSyncPushV1(options);
}

class AdbSyncSocketLocked {
    #writer;
    #readable;
    #socketLock;
    #writeLock = new AutoResetEvent();
    #combiner;
    get position() {
        return this.#readable.position;
    }
    constructor(writer, readable, bufferSize, lock) {
        this.#writer = writer;
        this.#readable = readable;
        this.#socketLock = lock;
        this.#combiner = new BufferCombiner(bufferSize);
    }
    #write(buffer) {
        // `#combiner` will reuse the buffer, so we need to use the Consumable pattern
        return Consumable.WritableStream.write(this.#writer, buffer);
    }
    async flush() {
        try {
            await this.#writeLock.wait();
            const buffer = this.#combiner.flush();
            if (buffer) {
                await this.#write(buffer);
            }
        }
        finally {
            this.#writeLock.notifyOne();
        }
    }
    async write(data) {
        try {
            await this.#writeLock.wait();
            for (const buffer of this.#combiner.push(data)) {
                await this.#write(buffer);
            }
        }
        finally {
            this.#writeLock.notifyOne();
        }
    }
    async readExactly(length) {
        // The request may still be in the internal buffer.
        // Call `flush` to send it before starting reading
        await this.flush();
        return await this.#readable.readExactly(length);
    }
    release() {
        // In theory, the writer shouldn't leave anything in the buffer,
        // but to be safe, call `flush` to throw away any remaining data.
        this.#combiner.flush();
        this.#socketLock.notifyOne();
    }
    async close() {
        await this.#readable.cancel();
    }
}
class AdbSyncSocket {
    #lock = new AutoResetEvent();
    #socket;
    #locked;
    constructor(socket, bufferSize) {
        this.#socket = socket;
        this.#locked = new AdbSyncSocketLocked(socket.writable.getWriter(), new BufferedReadableStream(socket.readable), bufferSize, this.#lock);
    }
    async lock() {
        await this.#lock.wait();
        return this.#locked;
    }
    async close() {
        await this.#locked.close();
        await this.#socket.close();
    }
}

/**
 * A simplified `dirname` function that only handles absolute unix paths.
 * @param path an absolute unix path
 * @returns the directory name of the input path
 */
function dirname(path) {
    const end = path.lastIndexOf("/");
    if (end === -1) {
        throw new Error(`Invalid path`);
    }
    if (end === 0) {
        return "/";
    }
    return path.substring(0, end);
}
class AdbSync {
    _adb;
    _socket;
    #supportsStat;
    #supportsListV2;
    #fixedPushMkdir;
    #supportsSendReceiveV2;
    #needPushMkdirWorkaround;
    get supportsStat() {
        return this.#supportsStat;
    }
    get supportsListV2() {
        return this.#supportsListV2;
    }
    get fixedPushMkdir() {
        return this.#fixedPushMkdir;
    }
    get supportsSendReceiveV2() {
        return this.#supportsSendReceiveV2;
    }
    get needPushMkdirWorkaround() {
        return this.#needPushMkdirWorkaround;
    }
    constructor(adb, socket) {
        this._adb = adb;
        this._socket = new AdbSyncSocket(socket, adb.maxPayloadSize);
        this.#supportsStat = adb.canUseFeature(AdbFeature.StatV2);
        this.#supportsListV2 = adb.canUseFeature(AdbFeature.ListV2);
        this.#fixedPushMkdir = adb.canUseFeature(AdbFeature.FixedPushMkdir);
        this.#supportsSendReceiveV2 = adb.canUseFeature(AdbFeature.SendReceiveV2);
        // https://android.googlesource.com/platform/packages/modules/adb/+/91768a57b7138166e0a3d11f79cd55909dda7014/client/file_sync_client.cpp#1361
        this.#needPushMkdirWorkaround =
            this._adb.canUseFeature(AdbFeature.ShellV2) && !this.fixedPushMkdir;
    }
    /**
     * Gets information of a file or folder.
     *
     * If `path` points to a symbolic link, the returned information is about the link itself (with `type` being `LinuxFileType.Link`).
     */
    async lstat(path) {
        return await adbSyncLstat(this._socket, path, this.#supportsStat);
    }
    /**
     * Gets the information of a file or folder.
     *
     * If `path` points to a symbolic link, it will be resolved and the returned information is about the target (with `type` being `LinuxFileType.File` or `LinuxFileType.Directory`).
     */
    async stat(path) {
        if (!this.#supportsStat) {
            throw new Error("Not supported");
        }
        return await adbSyncStat(this._socket, path);
    }
    /**
     * Checks if `path` is a directory, or a symbolic link to a directory.
     *
     * This uses `lstat` internally, thus works on all Android versions.
     */
    async isDirectory(path) {
        try {
            await this.lstat(path + "/");
            return true;
        }
        catch {
            return false;
        }
    }
    opendir(path) {
        return adbSyncOpenDir(this._socket, path, this.supportsListV2);
    }
    async readdir(path) {
        const results = [];
        for await (const entry of this.opendir(path)) {
            results.push(entry);
        }
        return results;
    }
    /**
     * Reads the content of a file on device.
     *
     * @param filename The full path of the file on device to read.
     * @returns A `ReadableStream` that contains the file content.
     */
    read(filename) {
        return adbSyncPull(this._socket, filename);
    }
    /**
     * Writes a file on device. If the file name already exists, it will be overwritten.
     *
     * @param options The content and options of the file to write.
     */
    async write(options) {
        if (this.needPushMkdirWorkaround) {
            // It may fail if `filename` already exists.
            // Ignore the result.
            // TODO: sync: test push mkdir workaround (need an Android 8 device)
            await this._adb.subprocess.noneProtocol.spawnWait([
                "mkdir",
                "-p",
                escapeArg(dirname(options.filename)),
            ]);
        }
        await adbSyncPush({
            v2: this.supportsSendReceiveV2,
            socket: this._socket,
            ...options,
        });
    }
    lockSocket() {
        return this._socket.lock();
    }
    dispose() {
        return this._socket.close();
    }
}

function parsePort(value) {
    if (!value || value === "0") {
        return undefined;
    }
    return Number.parseInt(value, 10);
}
class AdbTcpIpService extends AdbServiceBase {
    async getListenAddresses() {
        const serviceListenAddresses = await this.adb.getProp("service.adb.listen_addrs");
        const servicePort = await this.adb.getProp("service.adb.tcp.port");
        const persistPort = await this.adb.getProp("persist.adb.tcp.port");
        return {
            serviceListenAddresses: serviceListenAddresses != ""
                ? serviceListenAddresses.split(",")
                : [],
            servicePort: parsePort(servicePort),
            persistPort: parsePort(persistPort),
        };
    }
    async setPort(port) {
        if (port <= 0) {
            throw new TypeError(`Invalid port ${port}`);
        }
        const output = await this.adb.createSocketAndWait(`tcpip:${port}`);
        if (output !== `restarting in TCP mode port: ${port}\n`) {
            throw new Error(output);
        }
        return output;
    }
    async disable() {
        const output = await this.adb.createSocketAndWait("usb:");
        if (output !== "restarting in USB mode\n") {
            throw new Error(output);
        }
        return output;
    }
}

class Adb {
    #transport;
    get transport() {
        return this.#transport;
    }
    get serial() {
        return this.#transport.serial;
    }
    get maxPayloadSize() {
        return this.#transport.maxPayloadSize;
    }
    get banner() {
        return this.#transport.banner;
    }
    get disconnected() {
        return this.#transport.disconnected;
    }
    get clientFeatures() {
        return this.#transport.clientFeatures;
    }
    get deviceFeatures() {
        return this.banner.features;
    }
    subprocess;
    power;
    reverse;
    tcpip;
    constructor(transport) {
        this.#transport = transport;
        this.subprocess = new AdbSubprocessService(this);
        this.power = new AdbPower(this);
        this.reverse = new AdbReverseService(this);
        this.tcpip = new AdbTcpIpService(this);
    }
    canUseFeature(feature) {
        return (this.clientFeatures.includes(feature) &&
            this.deviceFeatures.includes(feature));
    }
    /**
     * Creates a new ADB Socket to the specified service or socket address.
     */
    async createSocket(service) {
        return this.#transport.connect(service);
    }
    async createSocketAndWait(service) {
        const socket = await this.createSocket(service);
        return await socket.readable
            .pipeThrough(new TextDecoderStream())
            .pipeThrough(new ConcatStringStream());
    }
    getProp(key) {
        return this.subprocess.noneProtocol
            .spawnWaitText(["getprop", key])
            .then((output) => output.trim());
    }
    rm(filenames, options) {
        const args = ["rm"];
        if (options?.recursive) {
            args.push("-r");
        }
        if (options?.force) {
            args.push("-f");
        }
        if (Array.isArray(filenames)) {
            for (const filename of filenames) {
                // https://github.com/microsoft/typescript/issues/17002
                args.push(escapeArg(filename));
            }
        }
        else {
            // https://github.com/microsoft/typescript/issues/17002
            args.push(escapeArg(filenames));
        }
        // https://android.googlesource.com/platform/packages/modules/adb/+/1a0fb8846d4e6b671c8aa7f137a8c21d7b248716/client/adb_install.cpp#984
        args.push("</dev/null");
        return this.subprocess.noneProtocol.spawnWaitText(args);
    }
    async sync() {
        const socket = await this.createSocket("sync:");
        return new AdbSync(this, socket);
    }
    async framebuffer() {
        return framebuffer(this);
    }
    async close() {
        await this.#transport.close();
    }
}

const AdbBannerKey = {
    Product: "ro.product.name",
    Model: "ro.product.model",
    Device: "ro.product.device",
    Features: "features",
};
class AdbBanner {
    static parse(banner) {
        let state;
        let product;
        let model;
        let device;
        let features = [];
        const pieces = banner.split("::");
        if (pieces.length > 1) {
            state = (pieces[0].trim() || undefined);
            const props = pieces[1];
            for (const prop of props.split(";")) {
                // istanbul ignore if
                if (!prop) {
                    continue;
                }
                const keyValue = prop.split("=");
                if (keyValue.length !== 2) {
                    continue;
                }
                const [key, value] = keyValue;
                switch (key) {
                    case AdbBannerKey.Product:
                        product = value;
                        break;
                    case AdbBannerKey.Model:
                        model = value;
                        break;
                    case AdbBannerKey.Device:
                        device = value;
                        break;
                    case AdbBannerKey.Features:
                        features = value.split(",");
                        break;
                }
            }
        }
        return new AdbBanner(state, product, model, device, features);
    }
    #state;
    get state() {
        return this.#state;
    }
    #product;
    get product() {
        return this.#product;
    }
    #model;
    get model() {
        return this.#model;
    }
    #device;
    get device() {
        return this.#device;
    }
    #features = [];
    get features() {
        return this.#features;
    }
    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(state, product, model, device, features) {
        this.#state = state;
        this.#product = product;
        this.#model = model;
        this.#device = device;
        this.#features = features;
    }
}

/**
 * Gets the `BigInt` value at the specified byte offset and length from the start of the view. There is
 * no alignment constraint; multi-byte values may be fetched from any offset.
 *
 * Only supports Big-Endian, because that's what ADB uses.
 * @param byteOffset The place in the buffer at which the value should be retrieved.
 */
function getBigUint(array, byteOffset, length) {
    let result = 0n;
    // The leading bytes that do not fill a whole 64-bit word.
    for (let j = 0; j < length % 8; j += 1) {
        result = (result << 8n) | BigInt(array[byteOffset + j]);
    }
    for (let i = byteOffset + (length % 8); i < byteOffset + length; i += 8) {
        result <<= 64n;
        const value = getUint64BigEndian(array, i);
        result |= value;
    }
    return result;
}
/**
 * Stores an arbitrary-precision positive `BigInt` value at the specified byte offset from the start of the view.
 * @param byteOffset The place in the buffer at which the value should be set.
 * @param length The number of bytes to set.
 * @param value The value to set.
 * @param littleEndian If `false` or `undefined`, a big-endian value should be written,
 * otherwise a little-endian value should be written.
 */
// eslint-disable-next-line @typescript-eslint/max-params
function setBigUint(array, byteOffset, length, value, littleEndian) {
    if (littleEndian) {
        while (value > 0n) {
            setInt64LittleEndian(array, byteOffset, value);
            byteOffset += 8;
            value >>= 64n;
        }
    }
    else {
        let position = byteOffset + length - 8;
        while (value > 0n) {
            setInt64BigEndian(array, position, value);
            position -= 8;
            value >>= 64n;
        }
    }
}
// References:
//
//   https://tools.ietf.org/html/rfc8017#appendix-A.1.2
//   PKCS #1: RSA Cryptography Specifications Version 2.2
//     A.1.2.  RSA Private Key Syntax
//
//   https://lapo.it/asn1js/
//   https://github.com/lapo-luchini/asn1js
//   ASN.1 JavaScript decoder
//
//   https://www.itu.int/rec/T-REC-X.690-201508-I/en
//   X.690: Specification of Distinguished Encoding Rules (DER)
/**
 * One DER tag-length-value header: where its content starts and how long it is.
 * @param data The DER-encoded data.
 * @param offset The offset of the header in the data.
 * @returns The content offset and length.
 */
function derHeader(data, offset) {
    offset = offset + 1; // Only low-tag-number forms occur in a PKCS #8 RSA key.
    let length = data[offset];
    offset += 1;
    if (length & 0x80) {
        const lengthBytes = length & 0x7f;
        length = 0;
        for (let i = 0; i < lengthBytes; i += 1) {
            length = (length << 8) | data[offset];
            offset += 1;
        }
    }
    return { offset, length };
}
function rsaParsePrivateKey(key) {
    // PrivateKeyInfo ::= SEQUENCE {
    //     version             INTEGER,
    //     privateKeyAlgorithm AlgorithmIdentifier,
    //     privateKey          OCTET STRING -- wrapping an RSAPrivateKey
    // }
    // RSAPrivateKey ::= SEQUENCE {
    //     version         Version,
    //     modulus         INTEGER, -- n
    //     publicExponent  INTEGER, -- e
    //     privateExponent INTEGER  -- d
    //     -- ... other fields omitted
    // }
    let offset = derHeader(key, 0).offset; // into PrivateKeyInfo
    let header = derHeader(key, offset); // skip version
    offset = header.offset + header.length;
    header = derHeader(key, offset); // skip privateKeyAlgorithm
    offset = header.offset + header.length;
    offset = derHeader(key, offset).offset; // into OCTET STRING
    offset = derHeader(key, offset).offset; // into RSAPrivateKey
    header = derHeader(key, offset); // skip version
    offset = header.offset + header.length;
    const nHeader = derHeader(key, offset); // get modulus
    offset = nHeader.offset + nHeader.length;
    const eHeader = derHeader(key, offset); // skip publicExponent
    offset = eHeader.offset + eHeader.length;
    const dHeader = derHeader(key, offset); // get privateExponent
    const n = getBigUint(key, nHeader.offset, nHeader.length);
    const d = getBigUint(key, dHeader.offset, dHeader.length);
    return [n, d];
}
function nonNegativeMod(m, d) {
    const r = m % d;
    if (r > 0) {
        return r;
    }
    return r + (d );
}
// https://en.wikipedia.org/wiki/Modular_multiplicative_inverse
// Solve for the smallest positive `x` in the equation `a * x ≡ 1 (mod m)`,
// or in other words, `a * x % m = 1`
// Taken from https://stackoverflow.com/a/51562038
// Only used with numbers smaller than 2^32 so doesn't need BigInt
function modInverse(a, m) {
    a = nonNegativeMod(a, m);
    if (!a || m < 2) {
        return NaN; // invalid input
    }
    // find the gcd
    const s = [];
    let b = m;
    while (b) {
        [a, b] = [b, a % b];
        s.push({ a, b });
    }
    /* istanbul ignore next */
    if (a !== 1) {
        return NaN; // inverse does not exists
    }
    // find the inverse
    let x = 1;
    let y = 0;
    for (let i = s.length - 2; i >= 0; i -= 1) {
        [x, y] = [y, x - y * Math.floor(s[i].a / s[i].b)];
    }
    return nonNegativeMod(y, m);
}
const ModulusLengthInBytes = 2048 / 8;
const ModulusLengthInWords = ModulusLengthInBytes / 4;
function adbGetPublicKeySize() {
    return 4 + 4 + ModulusLengthInBytes + ModulusLengthInBytes + 4;
}
function adbGeneratePublicKey(privateKey, output) {
    // cspell: ignore: mincrypt
    // Android 6 and earlier has its own encryption library called mincrypt
    // This is the RSA public key format used by mincrypt:
    // https://android.googlesource.com/platform/system/core/+/bb0c180e62703c2068a1b2c9f8ba6d634bf1553c/include/mincrypt/rsa.h#46
    // `n0inv` and `rr` are pre-calculated to speed up RSA operations
    // Android 7 switched its encryption library to BoringSSL, but still keeps the key format:
    // https://android.googlesource.com/platform/system/core.git/+/91784040db2b9273687f88d8b95f729d4a61ecc2/libcrypto_utils/android_pubkey.cpp#38
    // Except when reading a key, `n0inv` and `rr` are ignored (they are still populated when generating a key):
    // https://android.googlesource.com/platform/system/core.git/+/91784040db2b9273687f88d8b95f729d4a61ecc2/libcrypto_utils/android_pubkey.cpp#55
    // The public key is a struct (in little endian) of:
    //
    // [
    //   modulusLengthInWords, // 32-bit integer, a "word" is 32-bit so it must be 2048 / 8 / 4
    //                         // (the comment in Android source code is incorrect saying "This must be ANDROID_PUBKEY_MODULUS_SIZE")
    //   n0inv,                // 32-bit integer, the modular inverse of (lower 32 bits of `n`)
    //   modulus,              // `n`
    //   rr,                   // Montgomery parameter R^2
    //   exponent,             // 32-bit integer, must be 3 or 65537
    // ]
    let outputType;
    const outputLength = adbGetPublicKeySize();
    if (!output) {
        output = new Uint8Array(outputLength);
        outputType = "Uint8Array";
    }
    else {
        if (output.length < outputLength) {
            throw new TypeError("output buffer is too small");
        }
        outputType = "number";
    }
    const outputView = new DataView(output.buffer, output.byteOffset, output.length);
    let outputOffset = 0;
    // modulusLengthInWords
    outputView.setUint32(outputOffset, ModulusLengthInWords, true);
    outputOffset += 4;
    // extract `n` from private key
    const [n] = rsaParsePrivateKey(privateKey);
    // Calculate `n0inv`
    const n0inv = -modInverse(Number(n % 2n ** 32n), 2 ** 32);
    outputView.setInt32(outputOffset, n0inv, true);
    outputOffset += 4;
    // Write `n` (a.k.a. `modulus`)
    setBigUint(output, outputOffset, ModulusLengthInBytes, n, true);
    outputOffset += ModulusLengthInBytes;
    // Calculate rr = (2 ** (rsa_size)) ** 2 % n
    const rr = 2n ** 4096n % n;
    setBigUint(output, outputOffset, ModulusLengthInBytes, rr, true);
    outputOffset += ModulusLengthInBytes;
    // exponent
    outputView.setUint32(outputOffset, 65537, true);
    if (outputType === "Uint8Array") {
        return output;
    }
    else {
        return outputLength;
    }
}
/**
 * Modular exponentiation.
 *
 * Calculate `(base ** exponent) % modulus` without actually calculating `(base ** exponent)`.
 *
 * See https://en.wikipedia.org/wiki/Modular_exponentiation#Implementation_in_Lua
 */
function powMod(base, exponent, modulus) {
    if (modulus === 1n) {
        return 0n;
    }
    let r = 1n;
    base = base % modulus;
    while (exponent > 0n) {
        if (BigInt.asUintN(1, exponent) === 1n) {
            r = (r * base) % modulus;
        }
        base = (base * base) % modulus;
        exponent >>= 1n;
    }
    return r;
}
const SHA1_DIGEST_LENGTH = 20;
const ASN1_SEQUENCE = 0x30;
const ASN1_OCTET_STRING = 0x04;
const ASN1_NULL = 0x05;
const ASN1_OID = 0x06;
// PKCS#1 SHA-1 hash digest info
const SHA1_DIGEST_INFO = new Uint8Array([
    ASN1_SEQUENCE,
    0x0d + SHA1_DIGEST_LENGTH,
    ASN1_SEQUENCE,
    0x09,
    // SHA-1 (1 3 14 3 2 26)
    ASN1_OID,
    0x05,
    1 * 40 + 3,
    14,
    3,
    2,
    26,
    ASN1_NULL,
    0x00,
    ASN1_OCTET_STRING,
    SHA1_DIGEST_LENGTH,
]);
// SubtleCrypto.sign() will hash the given data and sign the hash
// But we don't need the hashing step
// (In another word, ADB just requires the client to
// encrypt the given data with its private key)
// However SubtileCrypto.encrypt() doesn't accept 'RSASSA-PKCS1-v1_5' algorithm
// So we need to implement the encryption by ourself
function rsaSign(privateKey, data) {
    const [n, d] = rsaParsePrivateKey(privateKey);
    // PKCS#1 padding
    const padded = new Uint8Array(256);
    let index = 0;
    padded[index] = 0;
    index += 1;
    padded[index] = 1;
    index += 1;
    const fillLength = padded.length - SHA1_DIGEST_INFO.length - data.length - 1;
    while (index < fillLength) {
        padded[index] = 0xff;
        index += 1;
    }
    padded[index] = 0;
    index += 1;
    padded.set(SHA1_DIGEST_INFO, index);
    index += SHA1_DIGEST_INFO.length;
    padded.set(data, index);
    // Encryption
    // signature = padded ** d % n
    const signature = powMod(getBigUint(padded, 0, padded.length), d, n);
    // `padded` is not used anymore,
    // re-use the buffer to store the result
    setBigUint(padded, 0, padded.length, signature, false);
    return padded;
}

const AdbCommand = {
    Auth: 0x48545541, // 'AUTH'
    Close: 0x45534c43, // 'CLSE'
    Connect: 0x4e584e43, // 'CNXN'
    Okay: 0x59414b4f, // 'OKAY'
    Open: 0x4e45504f, // 'OPEN'
    Write: 0x45545257, // 'WRTE'
};
const AdbPacketHeader = struct({
    command: u32,
    arg0: u32,
    arg1: u32,
    payloadLength: u32,
    checksum: u32,
    magic: s32,
}, { littleEndian: true });
function calculateChecksum(payload) {
    return payload.reduce((result, item) => result + item, 0);
}
class AdbPacketSerializeStream extends TransformStream {
    constructor() {
        const headerBuffer = new Uint8Array(AdbPacketHeader.size);
        super({
            transform: async (chunk, controller) => {
                await chunk.tryConsume(async (chunk) => {
                    const init = chunk;
                    init.payloadLength = init.payload.length;
                    AdbPacketHeader.serialize(init, headerBuffer);
                    await Consumable.ReadableStream.enqueue(controller, headerBuffer);
                    if (init.payloadLength) {
                        // USB protocol preserves packet boundaries,
                        // so we must write payload separately as native ADB does,
                        // otherwise the read operation on device will fail.
                        await Consumable.ReadableStream.enqueue(controller, init.payload);
                    }
                });
            },
        });
    }
}

const AdbAuthType = {
    Token: 1,
    Signature: 2,
    PublicKey: 3,
};
const AdbSignatureAuthenticator = async function* (credentialStore, getNextRequest) {
    for await (const key of credentialStore.iterateKeys()) {
        const packet = await getNextRequest();
        if (packet.arg0 !== AdbAuthType.Token) {
            return;
        }
        const signature = rsaSign(key.buffer, packet.payload);
        yield {
            command: AdbCommand.Auth,
            arg0: AdbAuthType.Signature,
            arg1: 0,
            payload: signature,
        };
    }
};
const AdbPublicKeyAuthenticator = async function* (credentialStore, getNextRequest) {
    const packet = await getNextRequest();
    if (packet.arg0 !== AdbAuthType.Token) {
        return;
    }
    let privateKey;
    for await (const key of credentialStore.iterateKeys()) {
        privateKey = key;
        break;
    }
    if (!privateKey) {
        privateKey = await credentialStore.generateKey();
    }
    const publicKeyLength = adbGetPublicKeySize();
    const [publicKeyBase64Length] = calculateBase64EncodedLength(publicKeyLength);
    const nameBuffer = privateKey.name?.length
        ? encodeUtf8(privateKey.name)
        : EmptyUint8Array;
    const publicKeyBuffer = new Uint8Array(publicKeyBase64Length +
        (nameBuffer.length ? nameBuffer.length + 1 : 0) + // Space character + name
        1);
    adbGeneratePublicKey(privateKey.buffer, publicKeyBuffer);
    encodeBase64(publicKeyBuffer.subarray(0, publicKeyLength), publicKeyBuffer);
    if (nameBuffer.length) {
        publicKeyBuffer[publicKeyBase64Length] = 0x20;
        publicKeyBuffer.set(nameBuffer, publicKeyBase64Length + 1);
    }
    yield {
        command: AdbCommand.Auth,
        arg0: AdbAuthType.PublicKey,
        arg1: 0,
        payload: publicKeyBuffer,
    };
};
const ADB_DEFAULT_AUTHENTICATORS = [
    AdbSignatureAuthenticator,
    AdbPublicKeyAuthenticator,
];
class AdbAuthenticationProcessor {
    authenticators;
    #credentialStore;
    #pendingRequest = new PromiseResolver();
    #iterator;
    constructor(authenticators, credentialStore) {
        this.authenticators = authenticators;
        this.#credentialStore = credentialStore;
    }
    #getNextRequest = () => {
        return this.#pendingRequest.promise;
    };
    async *#invokeAuthenticator() {
        for (const authenticator of this.authenticators) {
            for await (const packet of authenticator(this.#credentialStore, this.#getNextRequest)) {
                // If the authenticator yielded a response
                // Prepare `nextRequest` for next authentication request
                this.#pendingRequest = new PromiseResolver();
                // Yield the response to outer layer
                yield packet;
            }
            // If the authenticator returned,
            // Next authenticator will be given the same `pendingRequest`
        }
    }
    async process(packet) {
        if (!this.#iterator) {
            this.#iterator = this.#invokeAuthenticator();
        }
        this.#pendingRequest.resolve(packet);
        const result = await this.#iterator.next();
        if (result.done) {
            throw new Error("No authenticator can handle the request");
        }
        return result.value;
    }
    dispose() {
        void this.#iterator?.return?.();
    }
}

class AdbDaemonSocketController {
    #dispatcher;
    localId;
    remoteId;
    localCreated;
    service;
    #readable;
    #readableController;
    get readable() {
        return this.#readable;
    }
    #writableController;
    writable;
    #closed = false;
    #closedPromise = new PromiseResolver();
    get closed() {
        return this.#closedPromise.promise;
    }
    #socket;
    get socket() {
        return this.#socket;
    }
    #availableWriteBytesChanged;
    /**
     * When delayed ack is disabled, returns `Infinity` if the socket is ready to write
     * (exactly one packet can be written no matter how large it is), or `-1` if the socket
     * is waiting for ack message.
     *
     * When delayed ack is enabled, returns a non-negative finite number indicates the number of
     * bytes that can be written to the socket before waiting for ack message.
     */
    #availableWriteBytes = 0;
    constructor(options) {
        this.#dispatcher = options.dispatcher;
        this.localId = options.localId;
        this.remoteId = options.remoteId;
        this.localCreated = options.localCreated;
        this.service = options.service;
        this.#readable = new PushReadableStream((controller) => {
            this.#readableController = controller;
        });
        this.writable = new MaybeConsumableWritableStream({
            start: (controller) => {
                this.#writableController = controller;
                controller.signal.addEventListener("abort", () => {
                    this.#availableWriteBytesChanged?.reject(controller.signal.reason);
                });
            },
            write: async (data) => {
                const size = data.length;
                const chunkSize = this.#dispatcher.options.maxPayloadSize;
                for (let start = 0, end = chunkSize; start < size; start = end, end += chunkSize) {
                    const chunk = data.subarray(start, end);
                    await this.#writeChunk(chunk);
                }
            },
        });
        this.#socket = new AdbDaemonSocket(this);
        this.#availableWriteBytes = options.availableWriteBytes;
    }
    async #writeChunk(data) {
        const length = data.length;
        while (this.#availableWriteBytes < length) {
            // Only one lock is required because Web Streams API guarantees
            // that `write` is not reentrant.
            const resolver = new PromiseResolver();
            this.#availableWriteBytesChanged = resolver;
            await resolver.promise;
        }
        if (this.#availableWriteBytes === Infinity) {
            this.#availableWriteBytes = -1;
        }
        else {
            this.#availableWriteBytes -= length;
        }
        await this.#dispatcher.sendPacket(AdbCommand.Write, this.localId, this.remoteId, data);
    }
    async enqueue(data) {
        await this.#readableController.enqueue(data);
    }
    ack(bytes) {
        this.#availableWriteBytes += bytes;
        this.#availableWriteBytesChanged?.resolve();
    }
    async close() {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#availableWriteBytesChanged?.reject(new Error("Socket closed"));
        try {
            this.#writableController.error(new Error("Socket closed"));
        }
        catch {
            // ignore
        }
        await this.#dispatcher.sendPacket(AdbCommand.Close, this.localId, this.remoteId, EmptyUint8Array);
    }
    dispose() {
        this.#readableController.close();
        this.#closedPromise.resolve(undefined);
    }
}
/**
 * A duplex stream representing a socket to ADB daemon.
 */
class AdbDaemonSocket {
    #controller;
    get localId() {
        return this.#controller.localId;
    }
    get remoteId() {
        return this.#controller.remoteId;
    }
    get localCreated() {
        return this.#controller.localCreated;
    }
    get service() {
        return this.#controller.service;
    }
    get readable() {
        return this.#controller.readable;
    }
    get writable() {
        return this.#controller.writable;
    }
    get closed() {
        return this.#controller.closed;
    }
    constructor(controller) {
        this.#controller = controller;
    }
    close() {
        return this.#controller.close();
    }
}

/**
 * The dispatcher is the "dumb" part of the connection handling logic.
 *
 * Except some options to change some minor behaviors,
 * its only job is forwarding packets between authenticated underlying streams
 * and abstracted socket objects.
 *
 * The `Adb` class is responsible for doing the authentication,
 * negotiating the options, and has shortcuts to high-level services.
 */
class AdbPacketDispatcher {
    // ADB socket id starts from 1
    // (0 means open failed)
    #initializers = new AsyncOperationManager(1);
    /**
     * Socket local ID to the socket controller.
     */
    #sockets = new Map();
    #writer;
    options;
    #closed = false;
    #disconnected = new PromiseResolver();
    get disconnected() {
        return this.#disconnected.promise;
    }
    #incomingSocketHandlers = new Map();
    #readAbortController = new AbortController();
    constructor(connection, options) {
        this.options = options;
        // Don't allow negative values in dispatcher
        if (this.options.initialDelayedAckBytes < 0) {
            this.options.initialDelayedAckBytes = 0;
        }
        connection.readable
            .pipeTo(new WritableStream({
            write: async (packet, controller) => {
                switch (packet.command) {
                    case AdbCommand.Close:
                        await this.#handleClose(packet);
                        break;
                    case AdbCommand.Okay:
                        this.#handleOkay(packet);
                        break;
                    case AdbCommand.Open:
                        await this.#handleOpen(packet);
                        break;
                    case AdbCommand.Write:
                        // Don't await - let each socket handle its own backpressure
                        // without blocking other sockets' packet processing.
                        // Fatal errors are propagated via WritableStream's controller.
                        this.#handleWrite(packet).catch((e) => {
                            controller.error(e);
                        });
                        break;
                    default:
                        // Junk data may only appear in the authentication phase,
                        // since the dispatcher only works after authentication,
                        // all packets should have a valid command.
                        // (although it's possible that Adb added new commands in the future)
                        throw new Error(`Unknown command: ${packet.command.toString(16)}`);
                }
            },
        }), {
            preventCancel: options.preserveConnection ?? false,
            signal: this.#readAbortController.signal,
        })
            .then(() => {
            this.#dispose();
        }, (e) => {
            if (!this.#closed) {
                this.#disconnected.reject(e);
            }
            this.#dispose();
        });
        this.#writer = connection.writable.getWriter();
    }
    async #handleClose(packet) {
        // If the socket is still pending
        if (packet.arg0 === 0 &&
            this.#initializers.reject(packet.arg1, new Error("Socket open failed"))) {
            // Device failed to create the socket
            // (unknown service string, failed to execute command, etc.)
            // it doesn't break the connection,
            // so only reject the socket creation promise,
            // don't throw an error here.
            return;
        }
        // From https://android.googlesource.com/platform/packages/modules/adb/+/65d18e2c1cc48b585811954892311b28a4c3d188/adb.cpp#459
        /* According to protocol.txt, p->msg.arg0 might be 0 to indicate
         * a failed OPEN only. However, due to a bug in previous ADB
         * versions, CLOSE(0, remote-id, "") was also used for normal
         * CLOSE() operations.
         */
        // Ignore `arg0` and search for the socket
        const socket = this.#sockets.get(packet.arg1);
        if (socket) {
            await socket.close();
            socket.dispose();
            this.#sockets.delete(packet.arg1);
            return;
        }
        // TODO: adb: is double closing an socket a catastrophic error?
        // If the client sends two `CLSE` packets for one socket,
        // the device may also respond with two `CLSE` packets.
    }
    #handleOkay(packet) {
        let ackBytes;
        if (this.options.initialDelayedAckBytes !== 0) {
            if (packet.payload.length !== 4) {
                throw new Error("Invalid OKAY packet. Payload size should be 4");
            }
            ackBytes = getUint32LittleEndian(packet.payload, 0);
        }
        else {
            if (packet.payload.length !== 0) {
                throw new Error("Invalid OKAY packet. Payload size should be 0");
            }
            ackBytes = Infinity;
        }
        if (this.#initializers.resolve(packet.arg1, {
            remoteId: packet.arg0,
            availableWriteBytes: ackBytes,
        })) {
            // Device successfully created the socket
            return;
        }
        const socket = this.#sockets.get(packet.arg1);
        if (socket) {
            // When delayed ack is enabled, `ackBytes` is a positive number represents
            // how many bytes the device has received from this socket.
            // When delayed ack is disabled, `ackBytes` is always `Infinity` represents
            // the device has received last `WRTE` packet from the socket.
            socket.ack(ackBytes);
            return;
        }
        // Maybe the device is responding to a packet of last connection
        // Tell the device to close the socket
        void this.sendPacket(AdbCommand.Close, packet.arg1, packet.arg0, EmptyUint8Array);
    }
    #sendOkay(localId, remoteId, ackBytes) {
        let payload;
        if (this.options.initialDelayedAckBytes !== 0) {
            // TODO: try reusing this buffer to reduce memory allocation
            // However, that requires blocking reentrance of `sendOkay`, which might be more expensive
            payload = new Uint8Array(4);
            setUint32LittleEndian(payload, 0, ackBytes);
        }
        else {
            payload = EmptyUint8Array;
        }
        return this.sendPacket(AdbCommand.Okay, localId, remoteId, payload);
    }
    async #handleOpen(packet) {
        // Allocate a local ID for the socket from `#initializers`.
        // `AsyncOperationManager` doesn't directly support returning the next ID,
        // so use `add` + `resolve` to simulate this
        const [localId] = this.#initializers.add();
        this.#initializers.resolve(localId, undefined);
        const remoteId = packet.arg0;
        let availableWriteBytes = packet.arg1;
        let service = decodeUtf8(packet.payload);
        // ADB Daemon still adds a null character to the service string
        if (service.endsWith("\0")) {
            service = service.substring(0, service.length - 1);
        }
        // Check remote delayed ack enablement is consistent with local
        if (this.options.initialDelayedAckBytes === 0) {
            if (availableWriteBytes !== 0) {
                throw new Error("Invalid OPEN packet. arg1 should be 0");
            }
            availableWriteBytes = Infinity;
        }
        else {
            if (availableWriteBytes === 0) {
                throw new Error("Invalid OPEN packet. arg1 should be greater than 0");
            }
        }
        const handler = this.#incomingSocketHandlers.get(service);
        if (!handler) {
            await this.sendPacket(AdbCommand.Close, 0, remoteId, EmptyUint8Array);
            return;
        }
        const controller = new AdbDaemonSocketController({
            dispatcher: this,
            localId,
            remoteId,
            localCreated: false,
            service,
            availableWriteBytes,
        });
        try {
            await handler(controller.socket);
            this.#sockets.set(localId, controller);
            await this.#sendOkay(localId, remoteId, this.options.initialDelayedAckBytes);
        }
        catch {
            await this.sendPacket(AdbCommand.Close, 0, remoteId, EmptyUint8Array);
        }
    }
    async #handleWrite(packet) {
        const socket = this.#sockets.get(packet.arg1);
        if (!socket) {
            throw new Error(`Unknown local socket id: ${packet.arg1}`);
        }
        let handled = false;
        const promises = [
            (async () => {
                await socket.enqueue(packet.payload);
                await this.#sendOkay(packet.arg1, packet.arg0, packet.payload.length);
                handled = true;
            })(),
        ];
        if (this.options.readTimeLimit) {
            promises.push((async () => {
                await delay(this.options.readTimeLimit);
                if (!handled) {
                    throw new Error(`readable of \`${socket.service}\` has stalled for ${this.options.readTimeLimit} milliseconds`);
                }
            })());
        }
        await Promise.race(promises);
    }
    async createSocket(service) {
        if (this.options.appendNullToServiceString) {
            service += "\0";
        }
        const [localId, initializer] = this.#initializers.add();
        await this.sendPacket(AdbCommand.Open, localId, this.options.initialDelayedAckBytes, service);
        // Fulfilled by `handleOkay`
        const { remoteId, availableWriteBytes } = await initializer;
        const controller = new AdbDaemonSocketController({
            dispatcher: this,
            localId,
            remoteId,
            localCreated: true,
            service,
            availableWriteBytes,
        });
        this.#sockets.set(localId, controller);
        return controller.socket;
    }
    addReverseTunnel(service, handler) {
        this.#incomingSocketHandlers.set(service, handler);
    }
    removeReverseTunnel(address) {
        this.#incomingSocketHandlers.delete(address);
    }
    clearReverseTunnels() {
        this.#incomingSocketHandlers.clear();
    }
    async sendPacket(command, arg0, arg1, 
    // PERF: It's slightly faster to not use default parameter values
    payload) {
        if (typeof payload === "string") {
            payload = encodeUtf8(payload);
        }
        if (payload.length > this.options.maxPayloadSize) {
            throw new TypeError("payload too large");
        }
        await Consumable.WritableStream.write(this.#writer, {
            command,
            arg0,
            arg1,
            payload,
            checksum: this.options.calculateChecksum
                ? calculateChecksum(payload)
                : 0,
            magic: command ^ 0xffffffff,
        });
    }
    async close() {
        // Send `CLSE` packets for all sockets
        await Promise.all(Array.from(this.#sockets.values(), (socket) => socket.close()));
        // Stop receiving
        // It's possible that we haven't received all `CLSE` confirm packets,
        // but it doesn't matter, the next connection can cope with them.
        this.#closed = true;
        this.#readAbortController.abort();
        if (this.options.preserveConnection) {
            this.#writer.releaseLock();
        }
        else {
            await this.#writer.close();
        }
        // `pipe().then()` will call `dispose`
    }
    #dispose() {
        for (const socket of this.#sockets.values()) {
            socket.dispose();
        }
        this.#disconnected.resolve();
    }
}

const ADB_DAEMON_VERSION_OMIT_CHECKSUM = 0x01000001;
// https://android.googlesource.com/platform/packages/modules/adb/+/79010dc6d5ca7490c493df800d4421730f5466ca/transport.cpp#1252
// There are some other feature constants, but some of them are only used by ADB server, not devices (daemons).
const ADB_DAEMON_DEFAULT_FEATURES = /* #__PURE__ */ (() => [
    AdbFeature.ShellV2,
    AdbFeature.Cmd,
    AdbFeature.StatV2,
    AdbFeature.ListV2,
    AdbFeature.FixedPushMkdir,
    "apex",
    AdbFeature.Abb,
    // only tells the client the symlink timestamp issue in `adb push --sync` has been fixed.
    // No special handling required.
    "fixed_push_symlink_timestamp",
    AdbFeature.AbbExec,
    "remount_shell",
    "track_app",
    AdbFeature.SendReceiveV2,
    "sendrecv_v2_brotli",
    "sendrecv_v2_lz4",
    "sendrecv_v2_zstd",
    "sendrecv_v2_dry_run_send",
    AdbFeature.DelayedAck,
])();
const ADB_DAEMON_DEFAULT_INITIAL_PAYLOAD_SIZE = 32 * 1024 * 1024;
/**
 * An ADB Transport that connects to ADB Daemons directly.
 */
class AdbDaemonTransport {
    /**
     * Authenticate with the ADB Daemon and create a new transport.
     */
    static async authenticate({ serial, connection, credentialStore, authenticators = ADB_DEFAULT_AUTHENTICATORS, features = ADB_DAEMON_DEFAULT_FEATURES, initialDelayedAckBytes = ADB_DAEMON_DEFAULT_INITIAL_PAYLOAD_SIZE, ...options }) {
        // Initially, set to highest-supported version and payload size.
        let version = 0x01000001;
        // Android 4: 4K, Android 7: 256K, Android 9: 1M
        let maxPayloadSize = 1024 * 1024;
        const resolver = new PromiseResolver();
        const authProcessor = new AdbAuthenticationProcessor(authenticators, credentialStore);
        // Here is similar to `AdbPacketDispatcher`,
        // But the received packet types and send packet processing are different.
        const abortController = new AbortController();
        const pipe = connection.readable
            .pipeTo(new WritableStream({
            async write(packet) {
                switch (packet.command) {
                    case AdbCommand.Connect:
                        version = Math.min(version, packet.arg0);
                        maxPayloadSize = Math.min(maxPayloadSize, packet.arg1);
                        resolver.resolve(decodeUtf8(packet.payload));
                        break;
                    case AdbCommand.Auth: {
                        const response = await authProcessor.process(packet);
                        await sendPacket(response);
                        break;
                    }
                }
            },
        }), {
            // Don't cancel the source ReadableStream on AbortSignal abort.
            preventCancel: true,
            signal: abortController.signal,
        })
            .then(() => {
            // If `resolver` is already settled, call `reject` won't do anything.
            resolver.reject(new Error("Connection closed unexpectedly"));
        }, (e) => {
            resolver.reject(e);
        });
        const writer = connection.writable.getWriter();
        async function sendPacket(init) {
            // Always send checksum in auth steps
            // Because we don't know if the device needs it or not.
            init.checksum = calculateChecksum(init.payload);
            init.magic = init.command ^ 0xffffffff;
            await Consumable.WritableStream.write(writer, init);
        }
        const actualFeatures = features.slice();
        if (initialDelayedAckBytes <= 0) {
            const index = features.indexOf(AdbFeature.DelayedAck);
            if (index !== -1) {
                actualFeatures.splice(index, 1);
            }
        }
        let banner;
        try {
            await sendPacket({
                command: AdbCommand.Connect,
                arg0: version,
                arg1: maxPayloadSize,
                // The terminating `;` is required in formal definition
                // But ADB daemon (all versions) can still work without it
                payload: encodeUtf8(`host::features=${actualFeatures.join(",")}`),
            });
            banner = await resolver.promise;
        }
        finally {
            // When failed, release locks on `connection` so the caller can try again.
            // When success, also release locks so `AdbPacketDispatcher` can use them.
            abortController.abort();
            writer.releaseLock();
            // Wait until pipe stops (`ReadableStream` lock released)
            await pipe;
        }
        return new AdbDaemonTransport({
            serial,
            connection,
            version,
            maxPayloadSize,
            banner,
            features: actualFeatures,
            initialDelayedAckBytes,
            ...options,
        });
    }
    #connection;
    get connection() {
        return this.#connection;
    }
    #dispatcher;
    #serial;
    get serial() {
        return this.#serial;
    }
    #protocolVersion;
    get protocolVersion() {
        return this.#protocolVersion;
    }
    get maxPayloadSize() {
        return this.#dispatcher.options.maxPayloadSize;
    }
    #banner;
    get banner() {
        return this.#banner;
    }
    get disconnected() {
        return this.#dispatcher.disconnected;
    }
    #clientFeatures;
    get clientFeatures() {
        return this.#clientFeatures;
    }
    constructor({ serial, connection, version, banner, features = ADB_DAEMON_DEFAULT_FEATURES, initialDelayedAckBytes, ...options }) {
        this.#serial = serial;
        this.#connection = connection;
        this.#banner = AdbBanner.parse(banner);
        this.#clientFeatures = features;
        if (features.includes(AdbFeature.DelayedAck)) {
            if (initialDelayedAckBytes <= 0) {
                throw new TypeError("`initialDelayedAckBytes` must be greater than 0 when DelayedAck feature is enabled.");
            }
            if (!this.#banner.features.includes(AdbFeature.DelayedAck)) {
                initialDelayedAckBytes = 0;
            }
        }
        else {
            initialDelayedAckBytes = 0;
        }
        let calculateChecksum;
        let appendNullToServiceString;
        if (version >= ADB_DAEMON_VERSION_OMIT_CHECKSUM) {
            calculateChecksum = false;
            appendNullToServiceString = false;
        }
        else {
            calculateChecksum = true;
            appendNullToServiceString = true;
        }
        this.#dispatcher = new AdbPacketDispatcher(connection, {
            calculateChecksum,
            appendNullToServiceString,
            initialDelayedAckBytes,
            ...options,
        });
        this.#protocolVersion = version;
    }
    connect(service) {
        return this.#dispatcher.createSocket(service);
    }
    addReverseTunnel(handler, address) {
        if (!address) {
            const id = Math.random().toString().substring(2);
            address = `localabstract:reverse_${id}`;
        }
        this.#dispatcher.addReverseTunnel(address, handler);
        return address;
    }
    removeReverseTunnel(address) {
        this.#dispatcher.removeReverseTunnel(address);
    }
    clearReverseTunnels() {
        this.#dispatcher.clearReverseTunnels();
    }
    close() {
        return this.#dispatcher.close();
    }
}

function unorderedRemove(array, index) {
    if (index < 0 || index >= array.length) {
        return;
    }
    array[index] = array[array.length - 1];
    array.length -= 1;
}

class DeviceBusyError extends Error {
    constructor(cause) {
        super("The device is already in used by another program", {
            cause,
        });
    }
}

function isErrorName(e, name) {
    // node-usb package doesn't use `DOMException`,
    // so use a looser check
    // https://github.com/node-usb/node-usb/issues/573
    return (typeof e === "object" && e !== null && "name" in e && e.name === name);
}
function isUsbInterfaceFilter(filter) {
    return (filter.classCode !== undefined &&
        filter.subclassCode !== undefined &&
        filter.protocolCode !== undefined);
}
function matchUsbInterfaceFilter(alternate, filter) {
    return (alternate.interfaceClass === filter.classCode &&
        alternate.interfaceSubclass === filter.subclassCode &&
        alternate.interfaceProtocol === filter.protocolCode);
}
function findUsbInterface(device, filter) {
    for (const configuration of device.configurations) {
        for (const interface_ of configuration.interfaces) {
            for (const alternate of interface_.alternates) {
                if (matchUsbInterfaceFilter(alternate, filter)) {
                    return { configuration, interface_, alternate };
                }
            }
        }
    }
    return undefined;
}
function padNumber(value) {
    return value.toString(16).padStart(4, "0");
}
function getSerialNumber(device) {
    if (device.serialNumber) {
        return device.serialNumber;
    }
    return padNumber(device.vendorId) + "x" + padNumber(device.productId);
}
/**
 * Find the first pair of input and output endpoints from an alternate interface.
 *
 * ADB interface only has two endpoints, one for input and one for output.
 */
function findUsbEndpoints(endpoints) {
    if (endpoints.length === 0) {
        throw new TypeError("No endpoints given");
    }
    let inEndpoint;
    let outEndpoint;
    for (const endpoint of endpoints) {
        switch (endpoint.direction) {
            case "in":
                inEndpoint = endpoint;
                if (outEndpoint) {
                    return { inEndpoint, outEndpoint };
                }
                break;
            case "out":
                outEndpoint = endpoint;
                if (inEndpoint) {
                    return { inEndpoint, outEndpoint };
                }
                break;
        }
    }
    if (!inEndpoint) {
        throw new TypeError("No input endpoint found.");
    }
    if (!outEndpoint) {
        throw new TypeError("No output endpoint found.");
    }
    throw new Error("unreachable");
}
function matchFilter(device, filter) {
    if (filter.vendorId !== undefined && device.vendorId !== filter.vendorId) {
        return false;
    }
    if (filter.productId !== undefined &&
        device.productId !== filter.productId) {
        return false;
    }
    if (filter.serialNumber !== undefined &&
        getSerialNumber(device) !== filter.serialNumber) {
        return false;
    }
    if (isUsbInterfaceFilter(filter)) {
        return findUsbInterface(device, filter) || false;
    }
    return true;
}
function matchFilters(device, filters, exclusionFilters) {
    if (exclusionFilters && exclusionFilters.length > 0) {
        if (matchFilters(device, exclusionFilters)) {
            return false;
        }
    }
    for (const filter of filters) {
        const result = matchFilter(device, filter);
        if (result) {
            return result;
        }
    }
    return false;
}

/**
 * The default filter for ADB devices, as defined by Google.
 */
const AdbDefaultInterfaceFilter = {
    classCode: 0xff,
    subclassCode: 0x42,
    protocolCode: 1,
};
function mergeDefaultAdbInterfaceFilter(filters) {
    if (!filters || filters.length === 0) {
        return [AdbDefaultInterfaceFilter];
    }
    else {
        return filters.map((filter) => ({
            ...filter,
            classCode: filter.classCode ?? AdbDefaultInterfaceFilter.classCode,
            subclassCode: filter.subclassCode ?? AdbDefaultInterfaceFilter.subclassCode,
            protocolCode: filter.protocolCode ?? AdbDefaultInterfaceFilter.protocolCode,
        }));
    }
}
class AdbDaemonWebUsbConnection {
    #device;
    get device() {
        return this.#device;
    }
    #inEndpoint;
    get inEndpoint() {
        return this.#inEndpoint;
    }
    #outEndpoint;
    get outEndpoint() {
        return this.#outEndpoint;
    }
    #readable;
    get readable() {
        return this.#readable;
    }
    #writable;
    get writable() {
        return this.#writable;
    }
    constructor(device, inEndpoint, outEndpoint, usbManager) {
        this.#device = device;
        this.#inEndpoint = inEndpoint;
        this.#outEndpoint = outEndpoint;
        let closed = false;
        const duplex = new DuplexStreamFactory({
            close: async () => {
                try {
                    closed = true;
                    await device.raw.close();
                }
                catch {
                    /* device may have already disconnected */
                }
            },
            dispose: () => {
                closed = true;
                usbManager.removeEventListener("disconnect", handleUsbDisconnect);
            },
        });
        function handleUsbDisconnect(e) {
            if (e.device === device.raw) {
                duplex.dispose().catch(unreachable);
            }
        }
        usbManager.addEventListener("disconnect", handleUsbDisconnect);
        this.#readable = duplex.wrapReadable(new ReadableStream$1({
            pull: async (controller) => {
                const packet = await this.#transferIn();
                if (packet) {
                    controller.enqueue(packet);
                }
                else {
                    controller.close();
                }
            },
        }, { highWaterMark: 0 }));
        const zeroMask = outEndpoint.packetSize - 1;
        this.#writable = pipeFrom(duplex.createWritable(new MaybeConsumableWritableStream({
            write: async (chunk) => {
                try {
                    await device.raw.transferOut(outEndpoint.endpointNumber, toLocalUint8Array(chunk));
                    // In USB protocol, a not-full packet indicates the end of a transfer.
                    // If the payload size is a multiple of the packet size,
                    // we need to send an empty packet to indicate the end,
                    // so the OS will send it to the device immediately.
                    if (zeroMask && (chunk.length & zeroMask) === 0) {
                        await device.raw.transferOut(outEndpoint.endpointNumber, EmptyUint8Array);
                    }
                }
                catch (e) {
                    if (closed) {
                        return;
                    }
                    throw e;
                }
            },
        })), new AdbPacketSerializeStream());
    }
    async #transferIn() {
        try {
            while (true) {
                // ADB daemon sends each packet in two parts, the 24-byte header and the payload.
                const result = await this.#device.raw.transferIn(this.#inEndpoint.endpointNumber, this.#inEndpoint.packetSize);
                if (result.data.byteLength !== 24) {
                    continue;
                }
                // Per spec, the `result.data` always covers the whole `buffer`.
                const buffer = new Uint8Array(result.data.buffer);
                const stream = new Uint8ArrayExactReadable(buffer);
                // Add `payload` field to its type, it's assigned below.
                const packet = AdbPacketHeader.deserialize(stream);
                if (packet.magic !== (packet.command ^ 0xffffffff)) {
                    continue;
                }
                if (packet.payloadLength !== 0) {
                    const result = await this.#device.raw.transferIn(this.#inEndpoint.endpointNumber, packet.payloadLength);
                    packet.payload = new Uint8Array(result.data.buffer);
                }
                else {
                    packet.payload = EmptyUint8Array;
                }
                return packet;
            }
        }
        catch (e) {
            // On Windows, disconnecting the device will cause `NetworkError` to be thrown,
            // even before the `disconnect` event is fired.
            // Wait a little while and check if the device is still connected.
            // https://github.com/WICG/webusb/issues/219
            if (isErrorName(e, "NetworkError")) {
                await new Promise((resolve) => {
                    setTimeout(() => {
                        resolve();
                    }, 100);
                });
                if (closed) {
                    return undefined;
                }
            }
            throw e;
        }
    }
}
class AdbDaemonWebUsbDevice {
    static DeviceBusyError = DeviceBusyError;
    #interface;
    #usbManager;
    #raw;
    get raw() {
        return this.#raw;
    }
    #serial;
    get serial() {
        return this.#serial;
    }
    get name() {
        return this.#raw.productName;
    }
    /**
     * Create a new instance of `AdbDaemonWebUsbConnection` using a specified `USBDevice` instance
     *
     * @param device The `USBDevice` instance obtained elsewhere.
     * @param filters The filters to use when searching for ADB interface. Defaults to {@link ADB_DEFAULT_DEVICE_FILTER}.
     */
    constructor(device, interface_, usbManager) {
        this.#raw = device;
        this.#serial = getSerialNumber(device);
        this.#interface = interface_;
        this.#usbManager = usbManager;
    }
    async #claimInterface() {
        if (!this.#raw.opened) {
            await this.#raw.open();
        }
        const { configuration, interface_, alternate } = this.#interface;
        if (this.#raw.configuration?.configurationValue !==
            configuration.configurationValue) {
            // Note: Switching configuration is not supported on Windows,
            // but Android devices should always expose ADB function at the first (default) configuration.
            await this.#raw.selectConfiguration(configuration.configurationValue);
        }
        if (!interface_.claimed) {
            try {
                await this.#raw.claimInterface(interface_.interfaceNumber);
            }
            catch (e) {
                if (isErrorName(e, "NetworkError")) {
                    throw new AdbDaemonWebUsbDevice.DeviceBusyError(e);
                }
                throw e;
            }
        }
        if (interface_.alternate.alternateSetting !== alternate.alternateSetting) {
            await this.#raw.selectAlternateInterface(interface_.interfaceNumber, alternate.alternateSetting);
        }
        return findUsbEndpoints(alternate.endpoints);
    }
    /**
     * Open the device and create a new connection to the ADB Daemon.
     */
    async connect() {
        const { inEndpoint, outEndpoint } = await this.#claimInterface();
        return new AdbDaemonWebUsbConnection(this, inEndpoint, outEndpoint, this.#usbManager);
    }
}

/**
 * A watcher that listens for new WebUSB devices and notifies the callback when
 * a new device is connected or disconnected.
 */
class AdbDaemonWebUsbDeviceObserver {
    static async create(usb, options = {}) {
        const devices = await usb.getDevices();
        return new AdbDaemonWebUsbDeviceObserver(usb, devices, options);
    }
    #filters;
    #exclusionFilters;
    #usbManager;
    #onDeviceAdd = new EventEmitter();
    onDeviceAdd = this.#onDeviceAdd.event;
    #onDeviceRemove = new EventEmitter();
    onDeviceRemove = this.#onDeviceRemove.event;
    #onListChange = new StickyEventEmitter();
    onListChange = this.#onListChange.event;
    current = [];
    constructor(usb, initial, options = {}) {
        this.#filters = mergeDefaultAdbInterfaceFilter(options.filters);
        this.#exclusionFilters = options.exclusionFilters;
        this.#usbManager = usb;
        this.current = initial
            .map((device) => this.#convertDevice(device))
            .filter((device) => !!device);
        // Fire `onListChange` to set the sticky value
        this.#onListChange.fire(this.current);
        this.#usbManager.addEventListener("connect", this.#handleConnect);
        this.#usbManager.addEventListener("disconnect", this.#handleDisconnect);
    }
    #convertDevice(device) {
        const interface_ = matchFilters(device, this.#filters, this.#exclusionFilters);
        if (!interface_) {
            return undefined;
        }
        return new AdbDaemonWebUsbDevice(device, interface_, this.#usbManager);
    }
    #handleConnect = (e) => {
        const device = this.#convertDevice(e.device);
        if (!device) {
            return;
        }
        // We send a `connect` event on `requestDevice` success,
        // but this device might already exist if we already have the permission for it.
        if (this.current.some((item) => item.raw === device.raw)) {
            return;
        }
        const next = this.current.slice();
        next.push(device);
        this.current = next;
        this.#onDeviceAdd.fire([device]);
        this.#onListChange.fire(this.current);
    };
    #handleDisconnect = (e) => {
        const index = this.current.findIndex((device) => device.raw === e.device);
        if (index !== -1) {
            const device = this.current[index];
            const next = this.current.slice();
            unorderedRemove(next, index);
            this.current = next;
            this.#onDeviceRemove.fire([device]);
            this.#onListChange.fire(this.current);
        }
    };
    stop() {
        this.#usbManager.removeEventListener("connect", this.#handleConnect);
        this.#usbManager.removeEventListener("disconnect", this.#handleDisconnect);
        this.#onDeviceAdd.dispose();
        this.#onDeviceRemove.dispose();
        this.#onListChange.dispose();
    }
}

class AdbDaemonWebUsbDeviceManager {
    /**
     * Gets the instance of {@link AdbDaemonWebUsbDeviceManager} using browser WebUSB implementation.
     *
     * May be `undefined` if current runtime does not support WebUSB.
     */
    static BROWSER = /* #__PURE__ */ (() => typeof globalThis.navigator !== "undefined" && globalThis.navigator.usb
        ? new AdbDaemonWebUsbDeviceManager(globalThis.navigator.usb)
        : undefined)();
    #usbManager;
    /**
     * Create a new instance of {@link AdbDaemonWebUsbDeviceManager} using the specified WebUSB implementation.
     * @param usbManager A WebUSB compatible interface.
     */
    constructor(usbManager) {
        this.#usbManager = usbManager;
    }
    /**
     * Call `USB#requestDevice()` to prompt the user to select a device.
     */
    async requestDevice(options = {}) {
        const filters = mergeDefaultAdbInterfaceFilter(options.filters);
        try {
            const device = await this.#usbManager.requestDevice({
                filters,
                exclusionFilters: options.exclusionFilters,
            });
            const interface_ = matchFilters(device, filters, options.exclusionFilters);
            if (!interface_) {
                // `#usbManager` doesn't support `exclusionFilters`,
                // selected device is invalid
                return undefined;
            }
            // If this `requestDevice` adds a new device,
            // Chrome won't fire a `connect` event for it.
            // This will cause device observer to lose track of it,
            // and when the device disconnects, device observer won't fire the disconnect event for it.
            this.#usbManager.dispatchEvent(new USBConnectionEvent("connect", { device }));
            return new AdbDaemonWebUsbDevice(device, interface_, this.#usbManager);
        }
        catch (e) {
            // No device selected
            if (isErrorName(e, "NotFoundError")) {
                return undefined;
            }
            throw e;
        }
    }
    /**
     * Get all connected and requested devices that match the specified filters.
     */
    async getDevices(options = {}) {
        const filters = mergeDefaultAdbInterfaceFilter(options.filters);
        const devices = await this.#usbManager.getDevices();
        // filter map
        const result = [];
        for (const device of devices) {
            const interface_ = matchFilters(device, filters, options.exclusionFilters);
            if (interface_) {
                result.push(new AdbDaemonWebUsbDevice(device, interface_, this.#usbManager));
            }
        }
        return result;
    }
    trackDevices(options = {}) {
        return AdbDaemonWebUsbDeviceObserver.create(this.#usbManager, options);
    }
}

// cspell: ignore RSASSA
function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("Tango", 1);
        request.onerror = () => {
            reject(request.error);
        };
        request.onupgradeneeded = () => {
            const db = request.result;
            db.createObjectStore("Authentication", { autoIncrement: true });
        };
        request.onsuccess = () => {
            const db = request.result;
            resolve(db);
        };
    });
}
async function saveKey(key) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction("Authentication", "readwrite");
        const store = transaction.objectStore("Authentication");
        const putRequest = store.add(key);
        putRequest.onerror = () => {
            reject(putRequest.error);
        };
        putRequest.onsuccess = () => {
            resolve();
        };
        transaction.onerror = () => {
            reject(transaction.error);
        };
        transaction.oncomplete = () => {
            db.close();
        };
    });
}
async function getAllKeys() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction("Authentication", "readonly");
        const store = transaction.objectStore("Authentication");
        const getRequest = store.getAll();
        getRequest.onerror = () => {
            reject(getRequest.error);
        };
        getRequest.onsuccess = () => {
            resolve(getRequest.result);
        };
        transaction.onerror = () => {
            reject(transaction.error);
        };
        transaction.oncomplete = () => {
            db.close();
        };
    });
}
/**
 * An `AdbCredentialStore` implementation that creates RSA private keys using Web Crypto API
 * and stores them in IndexedDB.
 */
class AdbWebCredentialStore {
    #appName;
    constructor(appName = "Tango") {
        this.#appName = appName;
    }
    /**
     * Generates a RSA private key and store it into LocalStorage.
     *
     * Calling this method multiple times will overwrite the previous key.
     *
     * @returns The private key in PKCS #8 format.
     */
    async generateKey() {
        const { privateKey: cryptoKey } = await crypto.subtle.generateKey({
            name: "RSASSA-PKCS1-v1_5",
            modulusLength: 2048,
            // 65537
            publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
            hash: "SHA-1",
        }, true, ["sign", "verify"]);
        const privateKey = new Uint8Array(await crypto.subtle.exportKey("pkcs8", cryptoKey));
        await saveKey(privateKey);
        return {
            buffer: privateKey,
            name: `${this.#appName}@${globalThis.location.hostname}`,
        };
    }
    /**
     * Yields the stored RSA private key.
     *
     * This method returns a generator, so `for await...of...` loop should be used to read the key.
     */
    async *iterateKeys() {
        for (const key of await getAllKeys()) {
            yield {
                buffer: key,
                name: `${this.#appName}@${globalThis.location.hostname}`,
            };
        }
    }
}

/**
 * HDC 协议编解码（HarmonyOS Debug Connector）
 *
 * 依据 OpenHarmony 开源实现 developtools_hdc，不是猜测：
 *   - 帧头 PayloadHead   src/common/session.h:160   （packed，11 字节）
 *   - 握手 ChannelHandShake src/common/channel.h:36 （packed，108 = 44 + 64）
 *
 * 帧布局（实测字节数吻合）：
 *   [11 字节 PayloadHead][headSize 字节 会话头 protobuf][dataSize 字节 会话负载]
 *   总长 = 11 + headSize + dataSize
 *
 * 会话头是 protobuf：1=channelId 2=commandFlag 3=checkSum 4=vCode(=0x09)
 * vCode 是魔数，对不上时对端静默丢包（不报错），所以必须精确。
 *
 * ⚠️ 版本差异：帧格式在 hdc 6.x（HarmonyOS NEXT）上有变化，另一份针对
 * API 12+ 的实现观察到握手后是 [4 字节大端长度][payload]。本文件实现的是
 * 源码里 PayloadHead 那一版；两种都留了入口，等真机抓包定版本。
 */

/** 会话头魔数，必须等于 0x09 */
const VCODE = 0x09;
/** PayloadHead 起头两个字节 "HW" */
const FLAG_HW = [0x48, 0x57];
const PROTOCOL_VER = 0x01;
const HEAD_SIZE = 11;

// ---------------------------------------------------------------- protobuf

function encodeVarint(value) {
  const out = [];
  let v = value >>> 0;
  if (value < 0) throw new RangeError('varint 不支持负数');
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
  return out;
}

function decodeVarint(bytes, pos) {
  let result = 0;
  let shift = 1;
  let i = pos;
  for (;;) {
    if (i >= bytes.length) throw new RangeError('varint 越界');
    const b = bytes[i++];
    result += (b & 0x7f) * shift;
    if ((b & 0x80) === 0) break;
    shift *= 128;
    if (shift > 2 ** 53) throw new RangeError('varint 过长');
  }
  return { value: result, next: i };
}

new TextEncoder();
new TextDecoder();

function fieldVarint$1(num, value) {
  return [...encodeVarint(num * 8), ...encodeVarint(value)];
}

/** 极简 protobuf 解析：只处理 varint 与 length-delimited，够 hdc 用。 */
function decodeFields(bytes) {
  const fields = {};
  let pos = 0;
  while (pos < bytes.length) {
    const key = decodeVarint(bytes, pos);
    pos = key.next;
    const num = Math.floor(key.value / 8);
    const wire = key.value % 8;
    if (wire === 0) {
      const v = decodeVarint(bytes, pos);
      pos = v.next;
      fields[num] = v.value;
    } else if (wire === 2) {
      const len = decodeVarint(bytes, pos);
      pos = len.next;
      fields[num] = bytes.slice(pos, pos + len.value);
      pos += len.value;
    } else {
      throw new Error(`不支持的 protobuf wire type ${wire} (字段 ${num})`);
    }
  }
  return fields;
}

// ------------------------------------------------------------ 会话头

/** 会话头 protobuf：1=channelId 2=commandFlag 3=checkSum 4=vCode */
function encodeSessionHead({ channelId, commandFlag, checkSum = 0, vCode = VCODE }) {
  return [
    ...fieldVarint$1(1, channelId),
    ...fieldVarint$1(2, commandFlag),
    ...fieldVarint$1(3, checkSum),
    ...fieldVarint$1(4, vCode),
  ];
}

// ------------------------------------------------------------ 帧

function encodeFrame({ channelId, commandFlag, payload = [], checkSum = 0 }) {
  const head = encodeSessionHead({ channelId, commandFlag, checkSum });
  const data = [...payload];
  const frame = [
    ...FLAG_HW,
    0x00, 0x00,
    PROTOCOL_VER,
    (head.length >> 8) & 0xff, head.length & 0xff,
    (data.length >>> 24) & 0xff,
    (data.length >>> 16) & 0xff,
    (data.length >>> 8) & 0xff,
    data.length & 0xff,
    ...head,
    ...data,
  ];
  return new Uint8Array(frame);
}

function decodeFrame(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < HEAD_SIZE) throw new RangeError(`帧太短: ${bytes.length}`);
  if (bytes[0] !== FLAG_HW[0] || bytes[1] !== FLAG_HW[1]) {
    throw new Error(`帧标志不是 "HW": ${bytes[0].toString(16)} ${bytes[1].toString(16)}`);
  }
  const protocolVer = bytes[4];
  const headSize = (bytes[5] << 8) | bytes[6];
  const dataSize = ((bytes[7] << 24) >>> 0) + (bytes[8] << 16) + (bytes[9] << 8) + bytes[10];
  const need = HEAD_SIZE + headSize + dataSize;
  if (bytes.length < need) throw new RangeError(`帧不完整: 需要 ${need}，只有 ${bytes.length}`);

  const headBytes = bytes.slice(HEAD_SIZE, HEAD_SIZE + headSize);
  const payload = bytes.slice(HEAD_SIZE + headSize, need);
  const head = decodeFields(headBytes);

  // ⚠️ 负载**不一定是 protobuf**：
  //   · 握手帧的负载是 protobuf（需要 fields）
  //   · 命令帧的负载是纯文本（无 framing）
  //   · 通道关闭帧的负载是 1 字节裸值 0x00/0x01
  // 所以这里做容错解析，解不出就置 null，由调用方按 commandFlag 决定怎么读。
  let payloadFields = null;
  try {
    payloadFields = decodeFields(payload);
  } catch {
    payloadFields = null;
  }

  return {
    protocolVer,
    headSize,
    dataSize,
    totalSize: need,
    channelId: head[1],
    commandFlag: head[2],
    checkSum: head[3],
    vCode: head[4],
    payload,
    fields: payloadFields,
  };
}

/**
 * HDC 会话层：握手（含 AUTH 六步）与命令通道
 *
 * 全部常量与结构来自**真机抓包逐字节核对**（2026-11-21，Mate 70 Pro+ /
 * OpenHarmony 7.0.0.111 / API 26 / hdc client+daemon `Ver: 3.2.0f73c487f8b34a2ba5`），
 * 原始帧见 ./fixtures.json。
 *
 * 与早期猜测的差异（已实证修正）：
 *   · 会话 id 由**主机**随机生成，同时写入 USBHead.sessionId 与握手 f3
 *   · 第一帧的 f5(buf) 不是空，而是一个 94 字节特征串
 *   · 公钥放在 **f5(buf)**，不在 connectKey(4)；格式为 PEM，前面接
 *     `<主机名>` + 一个 0x0C 分隔字节
 *   · token 是 **20 个 ASCII 字符**
 *   · 签名是 **512 字符 base64**（= 384 字节，RSA-3072 + SHA-512，PKCS#1 v1.5）
 */


/** 握手命令号：CMD_KERNEL_HANDSHAKE */
const CMD_HANDSHAKE = 1;
/** 一次性命令：CMD_UNITY_EXECUTE（shell / param get 等） */
const CMD_UNITY_EXECUTE = 1001;
/** 命令输出帧 */
const CMD_OUTPUT = 10;
/** 通道关闭：CMD_KERNEL_CHANNEL_CLOSE */
const CMD_CHANNEL_CLOSE = 2;
/** 心跳：CMD_HEARTBEAT_MSG */
const CMD_HEARTBEAT = 5000;

const AUTH_NONE = 0;
const AUTH_SIGNATURE = 2;
const AUTH_PUBLICKEY = 3;
const AUTH_OK = 4;
const AUTH_FAIL = 5;

/** daemon 完整版本串（27 字节）；与本串不等会被断连 */
const DAEMON_VERSION = 'Ver: 3.2.0f73c487f8b34a2ba5';

/** 第一帧 f5：94 字节特征串（真机原文，空格不能改） */
const FEATURE_STRING =
  'authtype        1               1supportfeatures 29              Ver: 3.2.0f,USB,win,heartbeat';

/** 签名算法：RSA-PSS + SHA-512，salt 长度 = 摘要长度 64。
 *  实证来源：真机抓包里 hdc 对 20 字节 token 的 384 字节签名，
 *  只有 PSS/SHA-512/salt=64 能验通（PKCS#1 v1.5 全部验不过）。 */
const SIG_ALG = { name: 'RSA-PSS', saltLength: 64 };
const SIG_IMPORT_ALG = { name: 'RSA-PSS', hash: 'SHA-512' };

/** 主机名与 PEM 之间的分隔字节（真机为 0x0C） */
const HOSTNAME_SEP = 0x0c;

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------- 编解码

/** 握手帧：channelId 恒 0，commandFlag 恒 1 */
function buildHandshakeFrame({ sessionId, authType, connectKey = '', buf = '', version = DAEMON_VERSION }) {
  const payload = encodeHandshakePayload({ authType, sessionId, connectKey, buf, version });
  return encodeFrame({ channelId: 0, commandFlag: CMD_HANDSHAKE, payload });
}

function fieldVarint(num, value) {
  const out = [];
  let v = value >>> 0;
  while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
  out.push(v & 0x7f);
  return [num * 8, ...out];
}

function fieldBytes(num, bytes) {
  const out = [num * 8 + 2];
  let n = bytes.length;
  while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  out.push(n & 0x7f);
  return [...out, ...bytes];
}

/**
 * 握手负载。字段顺序以 session.h 的 struct SessionHandShake 为准：
 *   1=banner 2=authType 3=sessionId 4=connectKey 5=buf 6=version
 * `buf` 可以是字符串或 Uint8Array（公钥段含 0x0C 分隔字节，必须用 Uint8Array）。
 */
function encodeHandshakePayload({ authType, sessionId = 0, connectKey = '', buf = '', version = DAEMON_VERSION, banner = 'OHOS HDC' }) {
  const toBytes = (v) => (v instanceof Uint8Array ? v : enc.encode(String(v)));
  return new Uint8Array([
    ...fieldBytes(1, enc.encode(banner)),
    ...fieldVarint(2, authType),
    ...fieldVarint(3, sessionId),
    ...fieldBytes(4, toBytes(connectKey)),
    ...fieldBytes(5, toBytes(buf)),
    ...fieldBytes(6, enc.encode(version)),
  ]);
}

/**
 * 仅当这是握手帧（commandFlag=1）时才解析；心跳/输出/关闭等返回 null。
 * 传输层必须用它来过滤，否则心跳会被误当成 authType=0 的握手应答。
 */
function tryParseHandshakeFrame(input) {
  const f = decodeFrame(input);
  if (f.commandFlag !== CMD_HANDSHAKE) { return null; }
  const g = f.fields || {};
  return {
    commandFlag: f.commandFlag,
    channelId: f.channelId,
    authType: g[2] | 0,
    sessionId: g[3] | 0,
    connectKey: g[4] ? dec.decode(g[4]) : '',
    buf: g[5] instanceof Uint8Array ? g[5] : new Uint8Array(0),
    version: g[6] ? dec.decode(g[6]) : '',
  };
}

// ---------------------------------------------------------------- 公钥 / 签名

/** 把 WebCrypto 的 SPKI 公钥导出成 hdc 需要的 PEM 文本 */
function spkiToPem(spki) {
  const b64 = bytesToBase64$1(new Uint8Array(spki));
  const lines = [];
  for (let i = 0; i < b64.length; i += 64) { lines.push(b64.slice(i, i + 64)); }
  return '-----BEGIN PUBLIC KEY-----\n' + lines.join('\n') + '\n-----END PUBLIC KEY-----\n';
}

/** 拼出 AUTH 阶段 f5：<主机名> + 0x0C + PEM */
function buildPublicKeyBuf(hostname, pemText) {
  const h = enc.encode(hostname);
  const p = enc.encode(pemText);
  const out = new Uint8Array(h.length + 1 + p.length);
  out.set(h, 0);
  out[h.length] = HOSTNAME_SEP;
  out.set(p, h.length + 1);
  return out;
}

/** 生成 RSA-3072 密钥对（算法与 daemon 要求的 rsa_3072_sha512 一致） */
async function generateKeyPair() {
  return crypto.subtle.generateKey(
    {
      name: 'RSA-PSS',
      modulusLength: 3072,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: 'SHA-512',
    },
    true,
    ['sign', 'verify'],
  );
}

/** 对 token 签名，返回 512 字符 base64（= 384 字节） */
async function signToken(privateKey, token) {
  const tk = token instanceof Uint8Array ? token : enc.encode(String(token));
  const sig = await crypto.subtle.sign(SIG_ALG, privateKey, tk);
  return bytesToBase64$1(new Uint8Array(sig));
}

function bytesToBase64$1(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

// ---------------------------------------------------------------- 六步状态机

const STATES = {
  IDLE: 'idle',
  AWAIT_PUBKEY_REQUEST: 'await-pubkey-request',
  AWAIT_TOKEN: 'await-token',
  AWAIT_AUTH_OK: 'await-auth-ok',
  AUTHORIZED: 'authorized',
  FAILED: 'failed',
};

/**
 * 握手状态机。只做"根据 daemon 的应答决定下一步"，不碰任何 I/O，
 * 便于离线用真机字节回放验证。
 *
 * 用法：
 *   const hs = new Handshake({ sessionId, serial, keyPair, hostname });
 *   const first = await hs.start();            // 第 1 帧
 *   // 收到 daemon 应答后：
 *   const next = await hs.accept(parsedReply); // 第 3 或第 5 帧；null 表示已结束
 */
class Handshake {
  constructor({ sessionId, serial, hostname, keyPair, publicKeyPem, version = DAEMON_VERSION }) {
    if (!sessionId) { throw new Error('sessionId 必须由主机随机生成且非 0'); }
    this.sessionId = sessionId >>> 0;
    this.serial = serial;
    this.hostname = hostname;
    this.keyPair = keyPair || null;
    this.publicKeyPem = publicKeyPem || null;   // 复用已有密钥时直接给 PEM
    this.version = version;
    this.state = STATES.IDLE;
    this.token = null;
    this.pem = null;
    this.lastReply = null;
  }

  /** 第 1 帧：authType=NONE，connectKey=序列号，buf=特征串 */
  async start() {
    if (this.state !== STATES.IDLE) { throw new Error(`start() 状态不对: ${this.state}`); }
    if (this.publicKeyPem) { this.pem = this.publicKeyPem; }
    else if (this.keyPair) { this.pem = spkiToPem(await crypto.subtle.exportKey('spki', this.keyPair.publicKey)); }
    this.state = STATES.AWAIT_PUBKEY_REQUEST;
    return buildHandshakeFrame({
      sessionId: this.sessionId,
      authType: AUTH_NONE,
      connectKey: this.serial,
      buf: FEATURE_STRING,
      version: this.version,
    });
  }

  /**
   * 喂一个 daemon 应答；返回下一帧或 null。
   */
  async accept(reply) {
    this.lastReply = reply;
    const authType = reply.authType | 0;

    if (this.state === STATES.AWAIT_PUBKEY_REQUEST) {
      if (authType === AUTH_PUBLICKEY) {
        if (!this.pem) { throw new Error('daemon 索要公钥，但本机没有密钥对'); }
        this.state = STATES.AWAIT_TOKEN;
        return buildHandshakeFrame({
          sessionId: 0,
          authType: AUTH_PUBLICKEY,
          buf: buildPublicKeyBuf(this.hostname, this.pem),
          version: this.version,
        });
      }
      if (authType === AUTH_OK) { this.state = STATES.AUTHORIZED; return null; }   // 设备已授权过
      const bufText = reply.buf
        ? [...reply.buf].map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('')
        : '';
      if (authType === AUTH_FAIL) {
        this.state = STATES.FAILED;
        throw new Error(`daemon 拒绝了握手（AUTH_FAIL）${bufText ? '：' + bufText : ''}`);
      }
      throw new Error(`意外的 authType=${authType}（期望 3）${bufText ? ' buf=' + bufText.slice(0, 200) : ''}`);
    }

    if (this.state === STATES.AWAIT_TOKEN) {
      if (authType !== AUTH_SIGNATURE) {
        const t2 = reply.buf
          ? [...reply.buf].map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('')
          : '';
        throw new Error(`意外的 authType=${authType}（期望 2）${t2 ? ' buf=' + t2.slice(0, 300) : ''}`);
      }
      const buf = reply.buf || new Uint8Array(0);
      if (buf.length !== 20) { throw new Error(`token 长度应为 20，实际 ${buf.length}`); }
      this.token = buf;
      this.state = STATES.AWAIT_AUTH_OK;
      const sig = await signToken(this.keyPair.privateKey, buf);
      return buildHandshakeFrame({
        sessionId: 0,
        authType: AUTH_SIGNATURE,
        buf: sig,
        version: this.version,
      });
    }

    if (this.state === STATES.AWAIT_AUTH_OK) {
      if (authType === AUTH_OK) {
        const text = dec.decode(reply.buf || new Uint8Array(0));
        if (!/SUCCESS/.test(text)) { throw new Error('AUTH_OK 但状态串不是 SUCCESS: ' + text); }
        this.state = STATES.AUTHORIZED;
        return null;
      }
      this.state = STATES.FAILED;
      throw new Error(`授权失败，authType=${authType}`);
    }

    throw new Error(`状态 ${this.state} 下不接受应答`);
  }
}

// ---------------------------------------------------------------- 命令通道

/** 命令帧：channelId 非 0 随机值，负载就是命令文本（**不带 \0**） */
function buildCommandFrame({ channelId, text }) {
  if (!channelId) { throw new Error('命令帧 channelId 必须非 0'); }
  return encodeFrame({
    channelId: channelId >>> 0,
    commandFlag: CMD_UNITY_EXECUTE,
    payload: enc.encode(text),
  });
}

/** 关闭通道：(host 发 0x00，device 回 0x01) */
function buildCloseFrame({ channelId, side = 'host' }) {
  return encodeFrame({
    channelId: channelId >>> 0,
    commandFlag: CMD_CHANNEL_CLOSE,
    payload: new Uint8Array([side === 'host' ? 0x00 : 0x01]),
  });
}

/** 心跳帧（双向，commandFlag=5000） */
function buildHeartbeatFrame({ sessionId, count = 0 }) {
  return encodeFrame({
    channelId: 0,
    commandFlag: CMD_HEARTBEAT,
    payload: new Uint8Array([...fieldVarint(1, count), ...fieldBytes(2, [])]),
  });
}

/**
 * 解析命令应答。返回 { kind:'output'|'close'|'heartbeat'|'other', text? }
 */
function parseCommandReply(input) {
  const f = decodeFrame(input);
  if (f.commandFlag === CMD_OUTPUT) {
    return { kind: 'output', text: dec.decode(f.payload), channelId: f.channelId };
  }
  if (f.commandFlag === CMD_CHANNEL_CLOSE) {
    return {
      kind: 'close',
      side: f.payload[0] === 0x01 ? 'device' : 'host',
      channelId: f.channelId,
    };
  }
  if (f.commandFlag === CMD_HEARTBEAT) {
    return { kind: 'heartbeat' };
  }
  return { kind: 'other', commandFlag: f.commandFlag, channelId: f.channelId };
}
// ---------------------------------------------------------------- 复用已有 HDC 密钥

/** 从包含 PEM 的文本里取出指定类型的 base64 body */
function extractPemBlock(text, label) {
  const re = new RegExp('-----BEGIN ' + label + '-----([\\s\\S]*?)-----END ' + label + '-----');
  const m = String(text || '').match(re);
  return m ? m[1].replace(/[^A-Za-z0-9+/=]/g, '') : null;
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
  return out;
}

function bytesToPem(bytes, label) {
  return spkiToPem(bytes).replace('PUBLIC KEY', label);
}

// ---- 极简 DER 解析：只够从 PKCS#8 的 RSAPrivateKey 里取出 n / e ----

function derReadTlv(buf, pos) {
  if (pos + 2 > buf.length) { throw new Error('DER 越界'); }
  const tag = buf[pos];
  let len = buf[pos + 1];
  let off = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) { len = (len << 8) | buf[off + i]; }
    off += n;
  }
  return { tag, start: off, end: off + len, next: off + len };
}

function derChildren(buf, tlv) {
  const out = [];
  let pos = tlv.start;
  while (pos < tlv.end) {
    const c = derReadTlv(buf, pos);
    out.push(c);
    pos = c.next;
  }
  return out;
}

function derEncode(tag, content) {
  const len = content.length;
  let header;
  if (len < 0x80) { header = [tag, len]; }
  else if (len < 0x100) { header = [tag, 0x81, len]; }
  else if (len < 0x10000) { header = [tag, 0x82, (len >> 8) & 0xff, len & 0xff]; }
  else { header = [tag, 0x83, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]; }
  return new Uint8Array([...header, ...content]);
}

/** 从 PKCS#8 私钥 PEM 推导出 SPKI 公钥 PEM（WebCrypto 不支持直接从私钥导出公钥） */
function derivePublicKeyPem(pkcs8Pem) {
  const b64 = extractPemBlock(pkcs8Pem, 'PRIVATE KEY');
  if (!b64) { throw new Error('没找到 -----BEGIN PRIVATE KEY----- 块'); }
  const der = b64ToBytes(b64);
  const root = derReadTlv(der, 0);                       // PrivateKeyInfo
  const top = derChildren(der, root);
  // PrivateKeyInfo ::= SEQUENCE { version, AlgorithmIdentifier, OCTET STRING(privateKey) }
  const octet = top.find((t) => t.tag === 0x04);
  if (!octet) { throw new Error('PKCS#8 结构异常：缺少 privateKey OCTET STRING'); }
  const inner = der.slice(octet.start, octet.end);
  const rsa = derReadTlv(inner, 0);                      // RSAPrivateKey
  const parts = derChildren(inner, rsa);
  // RSAPrivateKey ::= SEQUENCE { version, n, e, d, p, q, ... }
  if (parts.length < 3) { throw new Error('RSAPrivateKey 字段不足'); }
  const n = inner.slice(parts[1].start, parts[1].end);
  const e = inner.slice(parts[2].start, parts[2].end);
  const rsaPub = derEncode(0x30, [...derEncode(0x02, n), ...derEncode(0x02, e)]);   // RSAPublicKey
  const algId = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86,
    0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);                                       // rsaEncryption
  const bitString = derEncode(0x03, [0x00, ...rsaPub]);
  const spki = derEncode(0x30, [...algId, ...bitString]);
  return spkiToPem(spki);
}

/**
 * 导入 hdc 自己的 PKCS#8 私钥（那把已被设备信任的密钥），
 * 返回 { privateKey, publicKeyPem }。公钥从私钥推导，或用文本里附带的 PUBLIC KEY 块。
 */
async function importHdcKey(pemText) {
  const pkcs8 = extractPemBlock(pemText, 'PRIVATE KEY');
  if (!pkcs8) { throw new Error('未找到 PKCS#8 私钥（-----BEGIN PRIVATE KEY-----）'); }
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    b64ToBytes(pkcs8),
    SIG_IMPORT_ALG,
    false,
    ['sign'],
  );
  const pubBlock = extractPemBlock(pemText, 'PUBLIC KEY');
  const publicKeyPem = pubBlock
    ? bytesToPem(b64ToBytes(pubBlock), 'PUBLIC KEY')
    : derivePublicKeyPem(pemText);
  return { privateKey, publicKeyPem };
}

/**
 * HDC over WebUSB —— 传输层与会话客户端
 *
 * 设计依据全部来自 2026-11-21 对**真 hdc.exe** 的抓包（见 ../docs/HDC_PROTOCOL.md
 * 与 ./fixtures.json），要点：
 *
 *   · 接口：class 0xFF / subclass 0x50 / protocol 0x01；bulk IN 0x81、OUT 0x01
 *   · 每个包前有 11 字节 USBHead{magic "UB", option, sessionId, dataSize}
 *   · **UB 头与帧必须分两次 bulk 写**（合并写会被 daemon 当 softreset 丢弃）
 *   · 连接建立先发 USBHead(option=2/RESET, size=0)，再发握手
 *   · 握手六步见 session.js；会话 id 由主机随机生成且非 0
 *   · 命令：commandFlag=1001，channelId 随机非 0，负载为纯文本（无 \0）
 *   · 输出：commandFlag=10；结束：commandFlag=2（主机发 0x00，设备回 0x01）
 *   · 心跳：双向，commandFlag=5000
 *
 * 本模块不直接依赖 navigator.usb，而是接受任意符合 WebUSB 形状的对象，
 * 因此可以用假设备离线回放真机字节做测试（见 transport.test.mjs）。
 */


const OPT_HEADER = 1;
const OPT_RESET = 2;
const USB_HEAD_SIZE = 11;
const MAGIC = [0x55, 0x42];
/** HDC 接口标识（真机实测） */
const IFACE_CLASS = 0xff;
const IFACE_SUBCLASS = 0x50;
const IFACE_PROTOCOL = 0x01;

const sleep$1 = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 生成一个非 0 的 31 位随机 id。
 *
 * ⚠️ 必须限制在 2^31-1 以内：真机抓包里 hdc 的 channelId 是 1309532605（< 2^31）。
 * 我们曾生成到 33 亿（> 2^31），daemon 内部按 int32 处理成负数，
 * 于是每条命令都**立刻被关闭通道且无输出**。
 */
function randomId() {
  let v = 0;
  while (v === 0) {
    const b = new Uint8Array(4);
    crypto.getRandomValues(b);
    v = ((((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3]) >>> 0) & 0x7fffffff;
  }
  return v >>> 0;
}

function buildUsbHead({ sessionId, dataSize, option = OPT_HEADER }) {
  const out = new Uint8Array(USB_HEAD_SIZE);
  out[0] = MAGIC[0];
  out[1] = MAGIC[1];
  out[2] = option & 0xff;
  new DataView(out.buffer).setUint32(3, sessionId >>> 0, false);
  new DataView(out.buffer).setUint32(7, dataSize >>> 0, false);
  return out;
}

function parseUsbHead(bytes) {
  if (bytes.length < USB_HEAD_SIZE) { throw new RangeError('UB 头不足 11 字节'); }
  if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1]) {
    throw new Error(`UB magic 不对: ${bytes[0].toString(16)} ${bytes[1].toString(16)}`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    option: bytes[2],
    sessionId: dv.getUint32(3, false),
    dataSize: dv.getUint32(7, false),
  };
}

/**
 * 不选配置也能找接口：直接用 getConfiguration 拿到的描述符树。
 * WebUSB 里 device.configuration 只有在 selectConfiguration 之后才有值，
 * 而 device.configurations 是描述符本身，随时可读。
 */
function findHdcInterfaceFromConfigurations(device) {
  // 总是遍历 device.configurations 找 HDC 接口，并把它所在的 configurationValue 一起返回。
  // （之前 device.configuration 有值时只走 findHdcInterface，拿不到 configurationValue，
  //  claim 时只能瞎猜 1 —— 多设备/重新插拔后这个猜测经常是错的。）
  const cfgs = device.configurations || [];
  for (const cfg of cfgs) {
    for (const iface of cfg.interfaces || []) {
      for (const alt of [iface.alternate, ...(iface.alternates || [])]) {
        if (!alt) { continue; }
        if (alt.interfaceClass === IFACE_CLASS
          && alt.interfaceSubclass === IFACE_SUBCLASS
          && alt.interfaceProtocol === IFACE_PROTOCOL) {
          const eps = findBulkEndpoints(alt);
          if (eps) {
            return {
              interfaceNumber: iface.interfaceNumber,
              configurationValue: cfg.configurationValue,
              ...eps,
            };
          }
        }
      }
    }
  }
  // 兜底：用当前 configuration
  if (device.configuration) { return findHdcInterface(device); }
  throw new Error('描述符里找不到 HDC 接口（class 0xFF/0x50/0x01）');
}

/** 在 WebUSB 设备里找 HDC 接口与该接口的两个 bulk 端点 */
function findHdcInterface(device) {
  const config = device.configuration;
  if (!config) { throw new Error('设备未选择配置'); }
  for (const iface of config.interfaces) {
    for (const alt of [iface.alternate, ...(iface.alternates || [])]) {
      if (
        alt.interfaceClass === IFACE_CLASS &&
        alt.interfaceSubclass === IFACE_SUBCLASS &&
        alt.interfaceProtocol === IFACE_PROTOCOL
      ) {
        const eps = findBulkEndpoints(alt);
        if (eps) { return { interfaceNumber: iface.interfaceNumber, ...eps }; }
      }
    }
  }
  // 退路：任何同时含 bulk IN/OUT 的 vendor-specific 接口
  for (const iface of config.interfaces) {
    const alt = iface.alternate;
    if (alt.interfaceClass === IFACE_CLASS) {
      const eps = findBulkEndpoints(alt);
      if (eps) { return { interfaceNumber: iface.interfaceNumber, ...eps }; }
    }
  }
  throw new Error('未找到 HDC 接口（class 0xFF/0x50/0x01）');
}

function findBulkEndpoints(alt) {
  let epIn = 0;
  let epOut = 0;
  for (const ep of alt.endpoints || []) {
    if (ep.type !== 'bulk') { continue; }
    if (ep.direction === 'in') { epIn = ep.endpointNumber; }
    if (ep.direction === 'out') { epOut = ep.endpointNumber; }
  }
  return epIn && epOut ? { endpointIn: epIn, endpointOut: epOut, packetSize: alt.endpoints[0]?.packetSize } : null;
}

/**
 * 纯传输层：负责 open/claim、11 字节头与帧的分两次写、以及读侧重组。
 * 不做任何协议语义。
 */
class HdcTransport {
  constructor(device, { readChunk = 512, logger = null } = {}) {
    this.device = device;
    this.readChunk = readChunk;
    this.logger = logger;          // (dir, text) => void，用于把收发过程显示出来
    this.iface = null;
    this.rx = new Uint8Array(0);
    this.opened = false;
    // 诊断计数：hdc server 被杀时 IN 端点里会残留半帧，需要重同步
    this.resyncs = 0;
    this.dropped = 0;
    this.pendingRead = null;   // 唯一的在途 IN 传输
  }

  static async requestDevice(usb, { vendorIds = [0x12d1] } = {}) {
    const filters = vendorIds.map((vendorId) => ({ vendorId }));
    const device = await usb.requestDevice({ filters });
    return device;
  }

  /**
   * 打开并 claim。带重试：手机在"始终信任"授权瞬间会重新枚举 USB，
   * 第一次 claim 常常正好撞在枚举空窗期，所以失败要退避重试几次。
   */
  async open({ attempts = 3, delayMs = 400 } = {}) {
    const d = this.device;
    let lastErr = null;
    let lastStep = 'open';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let step = 'open';
      try {
        if (!d.opened) { step = 'open'; await d.open(); }

        // ★ 关键差异：libusb 从不调用 SET_CONFIGURATION（它直接用现有配置），
        // 而 WebUSB 里我们过去总是先 selectConfiguration 才能枚举接口。
        // SET_CONFIGURATION 会重置所有接口/端点，很可能让 daemon 的回包发送失败
        // （真机日志里的 SendUSBRaw index failed）。
        // 所以：**先尝试不选配置直接 claim**，失败再退回选配置。
        step = 'claim';
        this.iface = findHdcInterfaceFromConfigurations(d);
        this.selectedConfig = false;
        try {
          await d.claimInterface(this.iface.interfaceNumber);
          this.emit('INFO', `claim 成功（未调用 selectConfiguration）iface=${this.iface.interfaceNumber}`);
        } catch (eClaimNoSel) {
          // 直接 claim 失败 → 无条件显式 selectConfiguration 再 claim。
          // 之前只在 d.configuration 为空时才回退，多设备/重新插拔后 configuration 已有值
          // 但接口并未真正激活，导致 claim 永远失败。这里改为总是回退。
          const cfgs = d.configurations || [];
          const cfgVal = this.iface.configurationValue
            || (d.configuration && d.configuration.configurationValue)
            || (cfgs[0] && cfgs[0].configurationValue) || 1;
          this.emit('INFO', `直接 claim 失败（${(eClaimNoSel && eClaimNoSel.message) || eClaimNoSel}），`
            + `回退 selectConfiguration(${cfgVal}) 后重新 claim`);
          await d.selectConfiguration(cfgVal);
          this.selectedConfig = true;
          for (let c = 1; c <= 3; c++) {
            try {
              await d.claimInterface(this.iface.interfaceNumber);
              this.emit('INFO', `回退 claim 成功 iface=${this.iface.interfaceNumber}`);
              break;
            } catch (eC) {
              if (c === 3) { throw eClaimNoSel; }
              this.emit('INFO', `回退 claim 第 ${c}/3 次失败：${(eC && eC.message) || eC}，300ms 后重试`);
              await sleep$1(300);
            }
          }
        }
        this.opened = true;
        return this.iface;
      } catch (e) {
        lastErr = e;
        lastStep = step;
        this.opened = false;
        this.emit('ERROR', `open 第 ${attempt}/${attempts} 次失败 step=${step}: `
          + `${(e && e.name) || 'Error'}: ${(e && e.message) || e}`);
        try { await d.close(); } catch { /* ignore */ }
        if (attempt < attempts) { await sleep$1(delayMs * attempt); }
      }
    }
    const where = lastStep === 'open'
      ? 'open 失败（设备被独占）'
      : (lastStep === 'claim' ? `claimInterface 失败（重试 ${attempts} 次）` : `${lastStep} 失败`);
    const desc = where
      + ` [class=0x${IFACE_CLASS.toString(16)} sub=0x${IFACE_SUBCLASS.toString(16)}`
      + ` proto=0x${IFACE_PROTOCOL.toString(16)}]`;
    const err = new Error(
      `${desc} → ${(lastErr && lastErr.name) || 'Error'}: ${(lastErr && lastErr.message) || lastErr}`,
    );
    err.cause = lastErr;
    err.step = lastStep;
    err.diagnostic = await diagnoseUsb().catch(() => null);
    throw err;
  }

  /**
   * 关键：**先写 11 字节 UB 头，再单独写帧**。
   * 合并成一次写会被 daemon 当 softreset 把负载丢掉（真机日志实证）。
   */
  async writeFrame({ sessionId, frame, option = OPT_HEADER }) {
    const head = buildUsbHead({ sessionId, dataSize: frame.length, option });
    this.emit('TX', `ub-head opt=${option} sid=0x${(sessionId >>> 0).toString(16).toUpperCase()} len=${frame.length}`);
    await this.writeOut(head, 'UB 头');
    if (option === OPT_RESET) { this.emit('TX', 'reset(无帧)'); return; }   // RESET 只有头，没有帧
    this.emit('TX', `frame ${frame.length}B ${bytesToHexPreview(frame)}`);
    await this.writeOut(frame, '帧');
  }

  /** 写 OUT；遇 STALL 先 clearHalt 再重试一次（设备被上次异常会话挂住时常见） */
  async writeOut(data, label) {
    for (let i = 0; i < 2; i++) {
      try {
        const r = await this.device.transferOut(this.iface.endpointOut, data);
        if (r && r.status === 'ok' && r.bytesWritten === data.length) { return; }
        throw new Error(`${r && r.status} ${r && r.bytesWritten}/${data.length}`);
      } catch (e) {
        if (i === 1) { throw new Error(`写${label}失败: ${(e && e.message) || e}`); }
        this.emit('INFO', `写${label}失败(${(e && e.message) || e})，clearHalt 后重试`);
        try { await this.device.clearHalt('out', this.iface.endpointOut); } catch { /* ignore */ }
        try { await this.device.clearHalt('in', this.iface.endpointIn); } catch { /* ignore */ }
        await sleep$1(120);
      }
    }
  }

  async reset() {
    await this.writeFrame({ sessionId: 0, frame: new Uint8Array(0), option: OPT_RESET });
  }

  /** 读一个完整包（UB 头 + 其声明的帧）。超时返回 null。 */
  async readPacket({ timeoutMs = 3000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const parsed = this.takeFromBuffer();
      if (parsed) { return parsed; }

      const remain = deadline - Date.now();
      if (remain <= 0) { return null; }

      // WebUSB 的 transferIn 没有超时参数，只能自己 race。
      // 但**不能每次 race 超时就丢下 promise 再新起一个**，否则端点上会堆积
      // 多个永远不会完成的传输。这里始终复用同一个在途传输。
      if (!this.pendingRead) {
        this.pendingRead = this.device.transferIn(this.iface.endpointIn, this.readChunk)
          .then((r) => { this.pendingRead = null; return r; },
                (e) => { this.pendingRead = null; throw e; });
      }
      const res = await Promise.race([
        this.pendingRead,
        sleep$1(remain).then(() => ({ status: 'timeout' })),
      ]);

      if (!res) { this.emit('RX', 'timeout（本轮无数据）'); return null; }
      if (res.status === 'timeout') { this.emit('RX', 'timeout（本轮无数据）'); return null; }
      if (res.status !== 'ok') {
        if (res.status === 'stall') {
          try { await this.device.clearHalt('in', this.iface.endpointIn); } catch { /* ignore */ }
          continue;
        }
        throw new Error(`读失败: ${res.status}`);
      }
      if (res.data && res.data.byteLength > 0) {
        this.append(new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength));
      }
    }
  }

  /** 记一条收发日志（没有 logger 时静默） */
  emit(dir, text) {
    if (this.logger) { this.logger(dir, text); }
  }

  append(chunk) {
    const next = new Uint8Array(this.rx.length + chunk.length);
    next.set(this.rx, 0);
    next.set(chunk, this.rx.length);
    this.rx = next;
  }

  /**
   * 从缓冲里取一个完整包。
   *
   * 必须具备**重同步**能力：设备 IN 端点里常残留上一次会话的半帧
   * （实测：hdc server 被杀后第一次读会拿到以 `10 01` 开头的残片），
   * 严格解析会直接抛错。这里的策略是跳过垃圾、对齐到 "UB"(0x55 0x42)。
   */
  takeFromBuffer() {
    for (;;) {
      // —— 对齐到 UB magic ——
      if (this.rx.length >= 2 && (this.rx[0] !== MAGIC[0] || this.rx[1] !== MAGIC[1])) {
        let idx = -1;
        for (let i = 1; i + 1 < this.rx.length; i++) {
          if (this.rx[i] === MAGIC[0] && this.rx[i + 1] === MAGIC[1]) { idx = i; break; }
        }
        if (idx < 0) {
          // 整段都找不到 magic：只保留末尾可能残缺的 0x55
          const keep = this.rx[this.rx.length - 1] === MAGIC[0] ? 1 : 0;
          this.dropped += this.rx.length - keep;
          this.rx = this.rx.slice(this.rx.length - keep);
          return null;                    // 需要更多数据才能重新对齐
        }
        this.emit('SYNC', `跳过 ${idx} 字节垃圾（对齐到 UB）`);
        this.dropped += idx;
        this.resyncs += 1;
        this.rx = this.rx.slice(idx);
      }

      if (this.rx.length < USB_HEAD_SIZE) { return null; }

      let head;
      try {
        head = parseUsbHead(this.rx.subarray(0, USB_HEAD_SIZE));
      } catch {
        this.dropped += 2;
        this.rx = this.rx.slice(2);
        continue;
      }

      // 头部字段合法性校验：option 只能是 1/2，长度不超过 1MB
      const optionOk = head.option === OPT_HEADER || head.option === OPT_RESET;
      if (!optionOk || head.dataSize > (1 << 20)) {
        this.dropped += 2;
        this.rx = this.rx.slice(2);
        continue;
      }

      const need = USB_HEAD_SIZE + head.dataSize;
      if (this.rx.length < need) { return null; }

      const frame = this.rx.slice(USB_HEAD_SIZE, need);
      this.rx = this.rx.slice(need);
      this.emit('RX', `pkt opt=${head.option} sid=0x${(head.sessionId >>> 0).toString(16).toUpperCase()} len=${head.dataSize} ${bytesToHexPreview(frame)}`);
      return { head, frame };
    }
  }

  /**
   * 丢弃端点里的残留数据：claim 之后、RESET 之后都该调一次。
   * 返回丢弃的包数。
   */
  async drainIdle({ timeoutMs = 150, rounds = 20 } = {}) {
    let got = 0;
    for (let i = 0; i < rounds; i++) {
      const p = await this.readPacket({ timeoutMs });
      if (!p) { break; }
      got += 1;
    }
    this.rx = new Uint8Array(0);       // 清掉不完整的尾巴
    return got;
  }

  async close() {
    // 注意：不能因为 this.opened 为 false 就直接返回。
    // open() 可能已经打开了 device（device.opened=true），但 claim 失败后 this.opened 仍是 false；
    // 这时若直接 return，device 句柄就泄漏了 —— 泄漏几次之后 WebUSB 会永久报 Access denied。
    try {
      if (this.iface && this.device) {
        await this.device.releaseInterface(this.iface.interfaceNumber);
      }
    } catch { /* ignore */ }
    try {
      if (this.device && this.device.opened) { await this.device.close(); }
    } catch { /* ignore */ }
    this.opened = false;
    this.iface = null;
  }
}

/**
 * 协议客户端：连接（RESET → 六步握手）→ 执行命令。
 */
class HdcSession {
  constructor(transport, { serial, hostname, version, keyPair, publicKeyPem, heartbeatMs = 5000, sessionId } = {}) {
    this.t = transport;
    this.serial = serial;
    this.hostname = hostname || 'dsh-web';
    this.version = version;
    this.keyPair = keyPair || null;
    this.publicKeyPem = publicKeyPem || null;
    this.heartbeatMs = heartbeatMs;
    /** 允许外部指定（测试用；生产应留空由 randomId() 生成） */
    this.fixedSessionId = (sessionId || 0) >>> 0;
    this.sessionId = 0;
    this.authorized = false;
    this.hbTimer = null;
    this.hbCount = 0;
    this.info = null;
    /** 被新连接取代时置 true：所有后续写入/重试必须立即停止 */
    this.aborted = false;
  }

  /** 标记此会话作废（被新连接取代 / 用户断开）：之后所有写入与重试立即停止 */
  abort(reason = 'unknown') {
    if (this.aborted) { return; }
    this.aborted = true;
    this.stopHeartbeat();
    try { this.t.emit('INFO', `会话作废（${reason}）`); } catch { /* ignore */ }
  }

  /** 写/重试前调用；作废后抛错，防止旧帧污染新会话 */
  ensureAlive() {
    if (this.aborted) { throw new Error('会话已作废，已中止操作'); }
  }

  /** 建立连接并完成 AUTH。返回 daemon 的 AUTH_OK 状态文本。 */
  async connect({ resetFirst = true, resetSettleMs = 150, confirmRounds = 7, confirmWaitMs = 9000 } = {}) {
    await this.t.open();
    this.ensureAlive();
    // 先纯被动监听：真机上 hdc 打开设备后 47ms 内设备就自发心跳。
    // 若这里一个包都收不到，说明是设备侧不发数据，而不是我们的握手有问题。
    this.t.emit('INFO', '被动监听 3 秒（不发任何数据）');
    const passive = await this.t.drainIdle({ timeoutMs: 3000, rounds: 4 });
    this.t.emit('INFO', `被动监听结束，收到 ${passive} 个包`);
    this.ensureAlive();

    let needConfirm = false;
    for (let round = 1; round <= confirmRounds; round++) {
      this.ensureAlive();
      try {
        return await this.handshake({ resetFirst: resetFirst || round > 1, resetSettleMs });
      } catch (e) {
        const code = e && e.code;
        if (code === 'NEED_CONFIRM') {
          needConfirm = true;
          this.t.emit('INFO', `[第 ${round}/${confirmRounds} 轮] 设备未授权本机密钥 → `
            + '★ 请在手机上点「允许 / 始终信任」，本机将在 ' + Math.round(confirmWaitMs / 1000)
            + ' 秒后自动重新握手');
          await sleep$1(confirmWaitMs);
          continue;
        }
        // 首次超时：换"不发 RESET"的变体再试一次
        const msg = String(e && e.message ? e.message : e);
        if (round === 1 && /等待应答|超时/.test(msg)) {
          this.t.emit('INFO', '变体：本次不发 RESET，直接重新握手');
          await this.t.drainIdle({ timeoutMs: 120, rounds: 10 });
          try {
            return await this.handshake({ resetFirst: false, resetSettleMs: 0 });
          } catch (e2) {
            if (e2 && e2.code === 'NEED_CONFIRM') {
              needConfirm = true;
              this.t.emit('INFO', '★ 请在手机上点「允许 / 始终信任」');
              await sleep$1(confirmWaitMs);
              continue;
            }
            throw e2;
          }
        }
        throw e;
      }
    }
    const err = new Error(needConfirm
      ? '设备始终未授权本机密钥：手机上可能没有出现授权弹窗，或没有点「允许」'
      : '握手未完成');
    err.code = needConfirm ? 'NEED_CONFIRM' : 'HANDSHAKE';
    throw err;
  }

  async handshake({ resetFirst = true, resetSettleMs = 150 } = {}) {
    if (resetFirst) {
      await this.t.reset();
      await sleep$1(resetSettleMs);
      await this.t.drainIdle({ timeoutMs: 120, rounds: 20 });
    }
    this.sessionId = this.fixedSessionId || randomId();
    const hs = new Handshake({
      sessionId: this.sessionId,
      serial: this.serial,
      hostname: this.hostname,
      keyPair: this.keyPair,
      publicKeyPem: this.publicKeyPem,
      ...(this.version ? { version: this.version } : {}),
    });

    let frame = await hs.start();
    this.ensureAlive();
    await this.t.writeFrame({ sessionId: this.sessionId, frame });

    const AUTH_NAMES = { 0: 'NONE', 1: 'TOKEN', 2: 'SIGNATURE', 3: 'PUBLICKEY', 4: 'OK', 5: 'FAIL' };
    let resendDone = false;
    let lastFrame = frame;         // 最后发出的握手帧（确认期间用于催应答）
    let lastNudge = 0;
    const HARD_DEADLINE = Date.now() + 75000;

    for (let guard = 0; guard < 60; guard++) {
      if (Date.now() > HARD_DEADLINE) { throw new Error('握手总超时（120 秒）'); }

      const timeoutMs = 8000;
      const pkt = await this.t.readPacket({ timeoutMs });

      if (!pkt) {
        if (confirmDeadline && Date.now() < confirmDeadline) {
          // 用户可能已经点了允许，但 daemon 没主动发 token：定期重发公钥帧催一次
          if (Date.now() - lastNudge > 12000) {
            lastNudge = Date.now();
            this.t.emit('INFO', '等待确认中…重发公钥帧以获取 token');
            await this.t.writeFrame({ sessionId: this.sessionId, frame: lastFrame });
          }
          continue;
        }
        if (!resendDone) {
          resendDone = true;
          this.t.emit('INFO', '首帧无应答，重发第 1 帧一次');
          await this.t.drainIdle({ timeoutMs: 100, rounds: 5 });
          await this.t.writeFrame({ sessionId: this.sessionId, frame });
          continue;
        }
        {
          const err = new Error(confirmDeadline
            ? '等待设备确认超时：手机上没有出现授权弹窗，或没有点「允许」'
            : '握手超时（等待应答失败）');
          err.code = confirmDeadline ? 'NEED_CONFIRM' : 'TIMEOUT';
          throw err;
        }
      }
      if (pkt.head.option !== OPT_HEADER) { continue; }

      // 过滤其它会话残留的包（设备侧会缓存上一次会话的应答）
      if (pkt.head.sessionId !== (this.sessionId >>> 0)) {
        this.t.emit('INFO', `忽略其它会话的包 sid=0x${(pkt.head.sessionId >>> 0).toString(16).toUpperCase()}`);
        continue;
      }

      let reply;
      try { reply = tryParseHandshakeFrame(pkt.frame); } catch { continue; }
      if (!reply) { continue; }

      const bufText = [...reply.buf].filter((c) => c >= 32 && c < 127).length >= 4
        ? decodeText(reply.buf.slice(0, 200)) : '';
      this.t.emit('INFO', `← 握手应答 authType=${reply.authType}(${AUTH_NAMES[reply.authType] || '?'}) `
        + `sid=${reply.sessionId} connectKey=${reply.connectKey.length}B buf=${reply.buf.length}B`);
      if (bufText) { this.t.emit('INFO', `   buf 文本: ${JSON.stringify(bufText)}`); }
      this.t.emit('HEX', `reply-frame ${pkt.frame.length}B: ${hexOf(pkt.frame, 512)}`);

      // ★ daemon 说"未授权，请在上机确认"。
      // 实测：它回完这条消息就**关闭会话**（紧跟一个 flag=2 关闭帧，随后心跳恢复），
      // 所以不能原地等 token —— 必须让用户去手机上点允许，然后**重新握手**。
      if (reply.authType === AUTH_OK && /UNAUTH|unauthorized|not set/i.test(bufText)) {
        const err = new Error('设备未授权本机密钥，需要在手机上确认');
        err.code = 'NEED_CONFIRM';
        throw err;
      }

      const next = await hs.accept(reply);
      this.info = reply;
      if (next === null) {
        this.authorized = true;
        break;
      }
      lastFrame = next;
      await this.t.writeFrame({ sessionId: hs.sessionId, frame: next });
    }
    if (!this.authorized) { throw new Error('握手未完成'); }

    // ★ 真机抓包实证：AUTH_OK 之后主机第一件事是**主动关闭通道 0**（握手通道），
    // 帧为 flag=2、payload 0x00。我们之前没关，设备便自己关（payload 0x01），
    // 之后所有命令通道都被立即关闭且无输出。
    try {
      await this.t.writeFrame({
        sessionId: this.sessionId,
        frame: buildCloseFrame({ channelId: 0, side: 'host' }),
      });
      this.t.emit('INFO', '已关闭握手通道(0)');
      await sleep$1(400);
    } catch (e) {
      this.t.emit('INFO', `关闭握手通道失败: ${(e && e.message) || e}`);
    }

    this.startHeartbeat();
    return hs.lastReply ? decodeText(hs.lastReply.buf) : '';
  }

  startHeartbeat() {
    if (!this.heartbeatMs || this.hbTimer || this.aborted || !this.authorized) { return; }
    this.hbTimer = setInterval(() => {
      if (this.aborted) { this.stopHeartbeat(); return; }
      const frame = buildHeartbeatFrame({ sessionId: this.sessionId, count: this.hbCount++ });
      this.t.writeFrame({ sessionId: this.sessionId, frame }).catch(() => { /* 心跳失败不致命 */ });
    }, this.heartbeatMs);
    if (this.hbTimer.unref) { this.hbTimer.unref(); }
  }

  stopHeartbeat() {
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
  }

  /**
   * 执行一条命令。返回 { text, codes }。
   * 依据抓包：一条命令 = 1 个输出帧 + 1 个关闭帧。
   */
  async shell(text, { timeoutMs = 20000, attempts = 3, retryDelayMs = 1200, retryOnEmpty = false } = {}) {
    if (!this.authorized) { throw new Error('尚未完成 AUTH'); }
    let last = null;
    for (let i = 1; i <= attempts; i++) {
      this.ensureAlive();
      last = await this.shellOnce(text, timeoutMs);
      // 关键：**空输出不等于失败**。echo/base64 -d 这类命令正常就是没有输出。
      // 只有"完全没收到设备关闭帧"（真超时）才重试；否则重试会让命令被执行两次
      // ——对 `>>` 追加写就是数据翻倍（真机上复现过：512KB 写成 983KB）。
      const ok = last.closed || (retryOnEmpty && last.text !== '');
      if (ok) { return last; }
      if (i < attempts) {
        this.t.emit('INFO', `命令无应答（第 ${i}/${attempts} 次），${retryDelayMs}ms 后换通道重试：${text}`);
        await sleep$1(retryDelayMs);
      }
    }
    this.t.emit('INFO', `命令无应答：${text}`);
    return last;
  }

  async shellOnce(text, timeoutMs = 20000) {
    this.ensureAlive();
    const channelId = randomId();
    await this.t.writeFrame({
      sessionId: this.sessionId,
      frame: buildCommandFrame({ channelId, text }),
    });

    const deadline = Date.now() + timeoutMs;
    let out = '';
    let sawDeviceClose = false;
    try {
      for (;;) {
        const remain = deadline - Date.now();
        if (remain <= 0) { throw new Error(`命令超时 ${timeoutMs}ms：${text}`); }
        const pkt = await this.t.readPacket({ timeoutMs: Math.min(remain, 3000) });
        if (!pkt) { throw new Error(`命令等待应答超时：${text}`); }
        if (pkt.head.option !== OPT_HEADER) { continue; }
        let f;
        try { f = decodeFrame(pkt.frame); } catch { continue; }
        if (f.commandFlag === 5000) { continue; }            // 心跳：忽略
        const kind = parseCommandReply(pkt.frame);
        const mine = kind.channelId === (channelId >>> 0);
        if (kind.kind === 'output') {
          if (!mine) {
            this.t.emit('INFO', `忽略其它通道的输出 ch=0x${(kind.channelId >>> 0).toString(16)}`);
            continue;
          }
          this.t.emit('INFO', `← 命令输出 ${kind.text.length} 字符`);
          out += kind.text;
          continue;
        }
        if (kind.kind === 'close') {
          if (!mine) {
            // 设备对"上一个通道"的关闭回执，与本次命令无关
            this.t.emit('INFO', `忽略其它通道的关闭 ch=0x${(kind.channelId >>> 0).toString(16)}`);
            continue;
          }
          this.t.emit('INFO', `← 本通道关闭 side=${kind.side}`);
          sawDeviceClose = true;
          if (kind.side === 'device') { break; }
          continue;
        }
        // 其他帧不认识的，忽略继续等
      }
    } finally {
      // 只有设备先关闭后才回发 host close；否则会把"设备尚未执行的通道"关掉
      if (!this.aborted && sawDeviceClose) try {
        await this.t.writeFrame({
          sessionId: this.sessionId,
          frame: buildCloseFrame({ channelId, side: 'host' }),
        });
      } catch { /* ignore */ }
    }
    return { text: out, closedEmpty: out === '', closed: sawDeviceClose };
  }

  async close() {
    this.stopHeartbeat();
    await this.t.close();
  }
}

function decodeText(bytes) {
  try { return new TextDecoder().decode(bytes); } catch { return ''; }
}
/**
 * 诊断：把 Chrome 眼里的设备/接口状态打出来。
 * `claimed` 特别关键——它由本页或别的页持有，能直接回答"接口是不是被占着"。
 */
async function diagnoseUsb() {
  if (typeof navigator === 'undefined' || !navigator.usb) {
    return { ok: false, error: '当前浏览器没有 WebUSB' };
  }
  let devices;
  try {
    devices = await Promise.race([
      navigator.usb.getDevices(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('getDevices 超时 5s')), 5000)),
    ]);
  } catch (e) {
    return { ok: false, error: 'getDevices 失败: ' + (e && e.message) };
  }
  const out = [];
  for (const d of devices) {
    const entry = {
      vid: '0x' + d.vendorId.toString(16),
      pid: '0x' + d.productId.toString(16),
      serial: d.serialNumber || '',
      opened: !!d.opened,
      productName: d.productName || '',
      configurationValue: d.configuration ? d.configuration.configurationValue : null,
      configurations: (d.configurations || []).map((c) => ({
        value: c.configurationValue,
        interfaces: (c.interfaces || []).map((i) => ({
          num: i.interfaceNumber,
          cls: '0x' + (i.alternate && i.alternate.interfaceClass || 0).toString(16),
          altCount: 1 + (i.alternates ? i.alternates.length : 0),
        })),
      })),
      interfaces: d.configuration
        ? d.configuration.interfaces.map((i) => {
            const a = i.alternate;
            return {
              interfaceNumber: i.interfaceNumber,
              claimed: !!i.claimed,
              class: '0x' + a.interfaceClass.toString(16),
              subclass: '0x' + a.interfaceSubclass.toString(16),
              protocol: '0x' + a.interfaceProtocol.toString(16),
              endpoints: a.endpoints.map(
                (e) => `${e.direction}:${e.endpointNumber}:${e.type}:pk${e.packetSize}`,
              ),
            };
          })
        : null,
    };
    // 诊断只读：绝不在这里 open/claim —— 那会卡在 Access denied 上，还会再泄漏句柄
    out.push(entry);
  }
  return { ok: true, count: devices.length, devices: out };
}


function bytesToHexPreview(bytes, n = 24) {
  const arr = bytes.subarray(0, Math.min(n, bytes.length));
  const hex = [...arr].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  return hex + (bytes.length > n ? ' ...' : '');
}


function hexOf(bytes, limit = 256) {
  const n = Math.min(limit, bytes.length);
  return [...bytes.subarray(0, n)].map((b) => b.toString(16).padStart(2, '0')).join(' ')
    + (bytes.length > n ? ` ...(+${bytes.length - n}B)` : '');
}

/**
 * 文件传输与 HAP 安装（HDC / HarmonyOS）
 *
 * 实现方式：走已验证可用的 shell 通道 + 设备自带的 `base64` / `sha256sum`。
 *
 * 全部参数都是**真机实测**得到的（Mate 70 Pro+ / API 26 / hdc daemon 3.2.0f）：
 *   · `echo -n '<b64>' | base64 -d > path`  写入，`>>` 追加     —— 可用
 *   · `base64 <path>` 读回，设备按 ~512B 分块推流              —— 可用（386KB 截图已验证）
 *   · `sha256sum <path>` 校验                                  —— 可用
 *   · **单条命令负载上限 ≈128KiB**：80KB 二进制（b64 109,228 字符）成功，
 *     96KB（b64 131,072）失败。故分块取 64KiB 二进制（b64 ~87KB）留足余量。
 *   · `bm install -p <hap>` / `bm uninstall` 设备侧可用
 *   · shell 身份 uid=2000(shell)，可写 `/data/local/tmp`；
 *     `/storage/media`、`/data/app` 等无权限
 *
 * 为什么不用 CMD_FILE_* 协议：那需要 INIT/BEGIN/DATA/FINISH 的完整字节序列，
 * 目前尚未用真机抓包确认（见 docs/HDC_FILE_INSTALL_RESEARCH.md 第二节）。
 * 这条 shell 路径已经实测可用，先交付能力，协议优化后续再做。
 */

/** 每次命令携带的二进制分块大小（base64 后约 87KB，低于 128KiB 上限） */
const CHUNK_SIZE = 64 * 1024;

/** pull 时的最大回传字节数，防止误拉超大文件把内存打爆 */
const PULL_MAX_BYTES = 64 * 1024 * 1024;

const B64_RE = /^[A-Za-z0-9+/=]+$/;

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
  return out;
}

/** 从命令输出里取出 sha256（跳过 `$ cmd` 回显行与错误行） */
function parseSha256(text) {
  const m = String(text || '').match(/\b([0-9a-f]{64})\b/i);
  return m ? m[1].toLowerCase() : '';
}

/** 本地字节的 sha256（hex） */
async function sha256Bytes(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 校验远端文件内容与本地一致。
 * 这一步不能省：shell 命令的失败信息走 stderr，我们只收 stdout，
 * 所以"命令返回 ok"不等于"文件写成功"（实测往无权限目录写会静默失败）。
 */
async function verifyRemote(session, remotePath, localBytes) {
  const [local, remoteRaw] = await Promise.all([
    sha256Bytes(localBytes),
    sha256Remote(session, remotePath),
  ]);
  if (!remoteRaw) {
    return { ok: false, local, remote: '', error: '远端文件不存在或不可读（写入很可能失败）' };
  }
  if (local !== remoteRaw) {
    return { ok: false, local, remote: remoteRaw, error: `校验不一致：本地 ${local.slice(0, 12)}… 远端 ${remoteRaw.slice(0, 12)}…` };
  }
  return { ok: true, local, remote: remoteRaw };
}

/** 把远端路径做 shell 转义（单引号包裹） */
function shellQuote$1(p) {
  return `'${String(p).replace(/'/g, `'\\''`)}'`;
}

/**
 * 写入**单块**到指定偏移（幂等）。用于分片上传：每次 HTTP 请求只带一块，
 * 避免超大请求体，也便于断点重传。
 * @param chunkSize 块大小（必须与 offset 对齐方式一致）
 * @param index 块序号，offset = index * chunkSize
 */
async function writeChunkAt(session, remotePath, chunkBytes, chunkSize, index, opts = {}) {
  const { log } = opts;
  const path = shellQuote$1(remotePath);
  const b64 = bytesToBase64(chunkBytes);
  const cmd = `echo -n '${b64}' | base64 -d | dd of=${path} bs=${chunkSize} seek=${index} conv=notrunc status=none`;
  if (cmd.length > 120 * 1024) {
    throw new Error(`内部错误：单块命令 ${cmd.length} 字符，超过实测上限 128KiB`);
  }
  // dd 写精确偏移，天然幂等；重试只会拖慢（等待设备关闭帧会被误判失败）
  await session.shell(cmd, { timeoutMs: 90000, attempts: 1 });
  if (log) { log(`写入第 ${index} 块（${chunkBytes.length} 字节 @ ${index * chunkSize}）`); }
  return { bytes: chunkBytes.length };
}

/**
 * 写入文件到设备。
 * @param session HdcSession
 * @param remotePath 远端绝对路径（需 shell 可写，实测 /data/local/tmp 可用）
 * @param bytes Uint8Array
 * @param opts { onProgress(done,total), log(msg) }
 */
async function pushFile(session, remotePath, bytes, opts = {}) {
  const { onProgress, log } = opts;
  const total = bytes.length;
  const path = shellQuote$1(remotePath);

  // 先删旧文件，避免追加到上次残留内容后面
  await session.shell(`rm -f ${path}`, { timeoutMs: 15000, attempts: 1 });

  if (total === 0) {
    await session.shell(`: > ${path}`, { timeoutMs: 15000, attempts: 1 });
    const ls = await session.shell(`ls -l ${path}`, { timeoutMs: 15000, attempts: 1 });
    if (/No such file|Permission denied/i.test(String(ls.text || ''))) {
      throw new Error(`上传失败：${String(ls.text || '').trim().slice(0, 160)}`);
    }
    if (onProgress) { onProgress(0, 0); }
    return { bytes: 0, chunks: 0 };
  }

  let chunks = 0;
  for (let off = 0; off < total; off += CHUNK_SIZE) {
    const end = Math.min(off + CHUNK_SIZE, total);
    const slice = bytes.subarray(off, end);
    const b64 = bytesToBase64(slice);
    // 用 dd 写到**精确偏移**（bs=块大小, seek=块序号, conv=notrunc）：
    // 这样即使同一条命令因为重试被执行两次，也只是覆盖同一区域，不会数据翻倍。
    const idx = off / CHUNK_SIZE;
    const cmd = `echo -n '${b64}' | base64 -d | dd of=${path} bs=${CHUNK_SIZE} seek=${idx} conv=notrunc status=none`;
    // 安全阀：命令长度必须低于实测上限
    if (cmd.length > 120 * 1024) {
      throw new Error(`内部错误：单条命令 ${cmd.length} 字符，超过实测上限 128KiB`);
    }
    await session.shell(cmd, { timeoutMs: 90000, attempts: 1 });
    chunks += 1;
    if (onProgress) { onProgress(end, total); }
    if (log) { log(`上传 ${Math.round((end / total) * 100)}%（${end}/${total} 字节）`); }
  }
  // 强制校验：写不进去（无权限/空间不足）时命令可能"看起来成功"
  const check = await verifyRemote(session, remotePath, bytes);
  if (!check.ok) {
    throw new Error(`上传失败：${check.error}`);
  }
  if (log) { log(`校验通过 sha256=${check.local.slice(0, 16)}…`); }
  return { bytes: total, chunks, sha256: check.local };
}

/**
 * 从设备读取文件。
 * @returns { bytes, b64Length }
 */
async function pullFile(session, remotePath, opts = {}) {
  const { onProgress, log } = opts;
  const path = shellQuote$1(remotePath);

  // 先确认文件存在与大小，避免大文件误拉
  const ls = await session.shell(`ls -l ${path}`, { timeoutMs: 15000, attempts: 1 });
  const lsText = String(ls.text || '');
  if (/No such file|Permission denied|not found/i.test(lsText)) {
    throw new Error(`远端文件不可读：${lsText.trim().slice(0, 160)}`);
  }
  const sizeMatch = lsText.match(/\s(\d+)\s+\d{4}-\d{2}-\d{2}/);
  if (sizeMatch) {
    const size = Number(sizeMatch[1]);
    if (size > PULL_MAX_BYTES) {
      throw new Error(`文件 ${size} 字节超过单次拉取上限 ${PULL_MAX_BYTES} 字节`);
    }
    if (log) { log(`远端文件 ${size} 字节，开始读取`); }
  }

  if (log) { log('读取中（设备按 ~512B 分块推流）'); }
  const r = await session.shell(`base64 ${path}`, { timeoutMs: 180000, attempts: 1 });
  const text = String(r.text || '').trim();

  // 输出可能被换行/回显污染：只保留 base64 字符
  const b64 = text.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && B64_RE.test(l) && !l.startsWith('base64 '))
    .join('');

  if (!b64) {
    throw new Error(`读取为空：${text.slice(0, 160) || '(无输出)'}`);
  }
  if (b64.length > PULL_MAX_BYTES * 2) {
    throw new Error(`回传过大（${b64.length} 字符），已中止`);
  }
  const bytes = base64ToBytes(b64);
  if (onProgress) { onProgress(bytes.length, bytes.length); }
  if (log) { log(`读取完成 ${bytes.length} 字节`); }
  return { bytes, b64Length: b64.length };
}

/** 取远端文件 sha256（用于校验） */
async function sha256Remote(session, remotePath) {
  const r = await session.shell(`sha256sum ${shellQuote$1(remotePath)}`, { timeoutMs: 30000, attempts: 2 });
  return parseSha256(r.text);
}

/**
 * 安装 HAP/HSP：先把包推到 /data/local/tmp，再执行 `bm install -p`。
 *
 * 注意：HAP 必须**已签名**，且调试签名的 Profile 必须包含本机 UDID，
 * 否则设备会返回 9568xxx 错误码。签名不由本插件生成，这里只负责传输与执行，
 * 并把设备返回的错误码翻成可读提示。
 */
async function installHap(session, { bytes, filename, replace = false }, opts = {}) {
  const { onProgress, log } = opts;
  const safeName = String(filename || 'bundle.hap').replace(/[^\w.\-]/g, '_');
  const remote = `/data/local/tmp/${Date.now()}_${safeName}`;

  if (log) { log(`推送安装包到 ${remote}（${bytes.length} 字节）`); }
  await pushFile(session, remote, bytes, { onProgress, log });
  const check = await verifyRemote(session, remote, bytes);
  if (!check.ok) {
    throw new Error(`安装包推送失败：${check.error}`);
  }
  if (log) { log(`安装包校验通过 sha256=${check.local.slice(0, 16)}…`); }
  if (log) { log('执行 bm install -p <包路径>'); }
  const args = replace ? `--replace` : '';
  const r = await session.shell(`bm install -p ${shellQuote$1(remote)} ${args}`.trim(),
    { timeoutMs: 240000, attempts: 1 });
  const out = String(r.text || '');

  // 清理临时包（保留在失败时便于排查？这里始终清理，避免占空间）
  session.shell(`rm -f ${shellQuote$1(remote)}`, { timeoutMs: 20000, attempts: 1 }).catch(() => {});

  const errMap = {
    '9568322': '签名不匹配：请确认 HAP 用调试证书签名，且调试 Profile 包含本机 UDID',
    '9568266': '需要 debug 签名的企业应用，或该包不是调试签名',
    '9568337': '安装包解析失败（文件损坏或不是合法 HAP）',
    '9568258': '已存在更高版本的同一应用',
    '9568305': '设备空间不足',
  };
  const codeMatch = out.match(/\b(9568\d{3})\b/);
  if (codeMatch) {
    const code = codeMatch[1];
    const hint = errMap[code] || '安装失败（未知错误码）';
    throw new Error(`安装失败 code:${code} —— ${hint}。设备原文：${out.trim().slice(0, 200)}`);
  }
  if (!/success/i.test(out) && out.trim()) {
    throw new Error(`安装未成功：${out.trim().slice(0, 200)}`);
  }
  return { output: out.trim(), remote };
}

/** 卸载 */
async function uninstallBundle(session, bundleName) {
  const r = await session.shell(`bm uninstall -n ${shellQuote$1(bundleName)}`, { timeoutMs: 60000, attempts: 1 });
  return String(r.text || '').trim();
}

/**
 * Android 侧文件传输与应用管理
 *
 * 依据 `@yume-chan/adb@2.6.4` 的真实类型定义实现：
 *   const sync = await adb.sync();                 // AdbSync
 *   await sync.write({ filename, file: ReadableStream<Uint8Array> });  // 推文件
 *   const stream = sync.read(filename);            // 拉文件，返回 ReadableStream
 *   await sync.dispose();                          // 必须释放，否则 socket 泄漏
 *
 * ADB sync 是二进制流式协议，速度远高于鸿蒙那边的 shell+base64，
 * 但仍保留 sha256 校验（写失败不报错是 shell 系的通病）。
 */

function bytesToReadableStream(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function readableStreamToBytes(stream) {
  const reader = stream.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) { break; }
    if (value) { parts.push(value); total += value.length; }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** 用 shell 执行并返回 { stdout, stderr, exitCode } */
async function runShell(adb, cmd) {
  const sp = adb.subprocess.shellProtocol;
  if (sp) {
    const r = await sp.spawnWaitText(cmd);
    return { stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.exitCode };
  }
  const text = await adb.subprocess.noneProtocol.spawnWaitText(cmd);
  return { stdout: text || '', stderr: '', exitCode: 0 };
}

function shellQuote(p) {
  return `'${String(p).replace(/'/g, `'\\''`)}'`;
}

/** 推文件到设备 */
async function pushFileAdb(adb, remotePath, bytes, opts = {}) {
  const { log } = opts;
  const dir = String(remotePath).replace(/\/[^/]*$/, '');
  const sync = await adb.sync();
  try {
    if (dir) {
      // 目录不存在时 sync.write 会失败，先建目录
      await adb.subprocess.noneProtocol.spawnWaitText(`mkdir -p ${shellQuote(dir)}`);
    }
    await sync.write({ filename: remotePath, file: bytesToReadableStream(bytes) });
    if (log) { log(`已写入 ${bytes.length} 字节 → ${remotePath}`); }
  } finally {
    try { await sync.dispose(); } catch { /* ignore */ }
  }
  return { bytes: bytes.length };
}

/** 从设备读文件 */
async function pullFileAdb(adb, remotePath, opts = {}) {
  const { log } = opts;
  const sync = await adb.sync();
  try {
    const stream = sync.read(remotePath);
    const bytes = await readableStreamToBytes(stream);
    if (log) { log(`已读取 ${bytes.length} 字节 ← ${remotePath}`); }
    return { bytes };
  } finally {
    try { await sync.dispose(); } catch { /* ignore */ }
  }
}

/**
 * 安装 APK：推到 /data/local/tmp 后 `pm install`。
 *
 * 用户已在设备上关闭华为安装验证后，pm install 直接返回 Success，不弹窗/不要密码。
 * 用 spawn（不等待）+ 收集输出流，避免前台 await 阻塞；超时则 kill 并提示人工确认。
 */
async function installApkAdb(adb, { bytes, filename, replace = false }, opts = {}) {
  const { log } = opts;
  const safe = String(filename || 'app.apk').replace(/[^\w.\-]/g, '_');
  const remote = `/data/local/tmp/${Date.now()}_${safe}`;
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

  if (log) { log(`推送 APK（${bytes.length} 字节）→ ${remote}`); }
  await pushFileAdb(adb, remote, bytes, opts);

  const argv = ['pm', 'install'];
  if (replace) { argv.push('-r'); }
  argv.push(remote);
  if (log) { log(`执行 ${argv.join(' ')}`); }

  const proc = await adb.subprocess.noneProtocol.spawn(argv);

  let output = '';
  const decoder = new TextDecoder();
  const pump = (async () => {
    const reader = proc.output.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { break; }
        if (value) { output += decoder.decode(value, { stream: true }); }
      }
    } catch { /* ignore */ }
  })();

  let exited = false;
  proc.exited.then(() => { exited = true; }).catch(() => { exited = true; });
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline && !exited) { await sleepMs(400); }

  let timedOut = false;
  if (!exited) { timedOut = true; try { await proc.kill(); } catch { /* ignore */ } }
  await Promise.race([pump, sleepMs(3000)]);
  adb.subprocess.noneProtocol.spawnWaitText(`rm -f ${shellQuote(remote)}`).catch(() => {});

  const out = output.trim();
  const errMap = {
    INSTALL_FAILED_ALREADY_EXISTS: '已存在同包名应用，请用「覆盖安装」',
    INSTALL_FAILED_UPDATE_INCOMPATIBLE: '已安装版本签名不同，需先卸载',
    INSTALL_FAILED_VERSION_DOWNGRADE: '版本号低于已安装版本，不能降级安装',
    INSTALL_FAILED_INSUFFICIENT_STORAGE: '设备空间不足',
    INSTALL_PARSE_FAILED_NOT_APK: '不是有效的 APK',
    INSTALL_FAILED_INVALID_APK: '安装包无效或被系统策略禁止更新',
    INSTALL_FAILED_USER_RESTRICTED: '设备策略禁止安装（可能开了纯净模式或安装验证）',
    INSTALL_FAILED_VERIFICATION_FAILURE: '系统安装校验失败',
  };
  for (const [code, hint] of Object.entries(errMap)) {
    if (out.includes(code)) { throw new Error(`安装失败 ${code} —— ${hint}。设备原文：${out.slice(0, 200)}`); }
  }
  if (timedOut) {
    throw new Error('安装超时：设备可能弹出了「安装确认 / 密码」框，请在手机上完成后重试（可在系统设置里关闭安装验证）');
  }
  if (!/Success/i.test(out)) {
    throw new Error(`安装未成功：${out.slice(0, 200) || '(无输出)'}`);
  }
  return { output: out, remote };
}

/** 卸载应用 */
async function uninstallPackageAdb(adb, pkg) {
  const r = await runShell(adb, `pm uninstall ${shellQuote(pkg)}`);
  const out = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
  if (!/Success/i.test(out)) {
    throw new Error(`卸载失败：${out.slice(0, 200) || '(无输出)'}`);
  }
  return out;
}

/** 客户端构建标记：显示在面板并随 poll 上报，用来确认浏览器加载的是哪一版 */
const BUILD_TAG = 'r110';

/** 浏览器里持久化的 HDC 私钥（PKCS#8 PEM）。同一把密钥只授权一次。 */
const HDC_KEY_STORE = 'mobile-bridge.hdc.pkcs8';

function readStoredHdcKey() {
  try { return localStorage.getItem(HDC_KEY_STORE) || ''; } catch { return ''; }
}

function storeHdcKey(pem) {
  try { localStorage.setItem(HDC_KEY_STORE, pem); return true; } catch { return false; }
}

const inject = ['slots', 'locale'];

const NS = 'mobile-bridge';
const h = React.createElement;

/**
 * 把 Tango / WebUSB 的英文异常翻译成可执行的下一步。
 * 认不出来的原样返回，便于贴到 Console 里排查。
 */
// 日志行形如 "HH:MM:SS.mmm LEVEL msg"；RX/TX/DBG 是协议原始帧，默认不展示给普通用户
function isReadableLogLine(line) {
  const m = String(line).match(/^\d\d:\d\d:\d\d\.\d+\s+([A-Z]+)\s/);
  if (!m) { return true; }
  return !['RX', 'TX', 'DBG'].includes(m[1]);
}

function friendly(raw, t, kind = 'adb') {
  // 第 7 轮实测结论：hdc server 常驻时，连 open 都拿不到句柄。
  // open 失败 = 设备被别的程序独占，与驱动无关（interface 0 已确认是 WINUSB）。
  if (/open 失败（设备被独占）/.test(raw)) return t('errExclusive');
  if (/already in use[d]? by another program|device in use|resource busy/i.test(raw)) return t('errBusy');
  // 浏览器接管接口失败：Android 侧通常是驱动问题；HarmonyOS 侧几乎总是 hdc server 占着
  if (/claim interface|failed to claim|unable to claim|access denied|not allowed|security/i.test(raw)) {
    return kind === 'hdc' ? t('errHdcBusy') : t('errDriver');
  }
  if (/no device selected|no device/i.test(raw)) return '';
  if (/user gesture/i.test(raw)) return t('errGesture');
  return '';
}

/**
 * 连接状态放在模块作用域，而不是组件 state。
 *
 * 设置页关闭时这个 section 会被卸载；如果连接挂在组件里，卸载就等于
 * 主动断开（之前的 bug）。放在模块里以后：关掉设置再打开、切到别的
 * 设置页再切回来，都还是连着的。只有刷新页面才会真正断开，
 * 那种情况交给挂载时的静默重连。
 */
const STATE = {
  adb: null,          // Android: Tango 的 Adb 实例
  hdc: null,          // HarmonyOS: HdcSession 实例
  device: null,       // 当前占用的 USBDevice
  info: null,         // 面板展示用的设备信息
  pending: null,      // 挂载时静默重连的进行中 Promise
  kind: null,         // 'adb' | 'hdc'
  log: [],            // HDC 收发日志（失败时显示到输出区）
  notify: null,       // 面板注册的实时刷新回调
  lastConnectError: null,   // 最近一次连接失败原因（上报给宿主诊断）
  hdcKeyText: '',     // 保留字段（已不再暴露 UI）
  connectToken: 0,    // 每次连接自增；旧任务发现令牌变化即放弃
  connectInFlight: null,  // 串行化：同一时刻只允许一个连接流程
  hdcPending: null,   // 进行中的 HDC 会话（自动重连/手动连接都可能留下）
  keepAlive: null,    // 后台保活句柄
  agc: { state: 'idle', qr: '', message: '' },   // 华为账号登录状态
  agcView: null,   // 遥控浏览器截图 { image, width, height }
  connection: null,   // 宿主 RPC 连接（用于把 HDC 日志送到宿主落盘）
  sessions: [],       // 多设备：每项 { id, kind, adb, hdc, device, info }
  activeId: null,     // 当前活跃设备 id
};

/** 设备唯一键：类型 + 序列号 */
function sessionKey(kind, info, device) {
  const serial = (info && info.serial)
    || (device && (device.serialNumber || device.serial)) || '';
  return kind + ':' + (serial || 'unknown');
}

/** 把当前 STATE 的活跃会话回写到 sessions（保证引用最新） */
function syncActiveToSessions() {
  if (!STATE.activeId) { return; }
  const s = STATE.sessions.find((x) => x.id === STATE.activeId);
  if (s) {
    s.kind = STATE.kind; s.adb = STATE.adb; s.hdc = STATE.hdc;
    s.device = STATE.device; s.info = STATE.info; s.log = STATE.log;
  }
}

/** 把当前 STATE 里的设备登记为会话（并设为活跃） */
function registerCurrentSession() {
  if (!STATE.kind || (!STATE.adb && !STATE.hdc)) { return; }
  const id = sessionKey(STATE.kind, STATE.info, STATE.device);
  const prev = STATE.sessions.find((s) => s.id === id);
  if (prev && (prev.adb !== STATE.adb || prev.hdc !== STATE.hdc)) {
    // 同 id 但不同实例：关闭旧实例，避免 claim 泄漏
    if (prev.hdc && prev.hdc !== STATE.hdc) { try { prev.hdc.close(); } catch { /* ignore */ } }
    if (prev.adb && prev.adb !== STATE.adb) { try { prev.adb.close(); } catch { /* ignore */ } }
  }
  STATE.sessions = STATE.sessions.filter((s) => s.id !== id);
  STATE.sessions.push({
    id, kind: STATE.kind, adb: STATE.adb, hdc: STATE.hdc,
    device: STATE.device, info: STATE.info, log: STATE.log,
  });
  STATE.activeId = id;
}

/** 切换活跃设备（STATE.adb/hdc/... 变成该设备的投影） */
function setActive(id) {
  syncActiveToSessions();
  const s = STATE.sessions.find((x) => x.id === id);
  if (!s) { return false; }
  STATE.activeId = s.id;
  STATE.kind = s.kind; STATE.adb = s.adb; STATE.hdc = s.hdc;
  STATE.device = s.device; STATE.info = s.info;
  STATE.log = s.log || [];     // 切到该设备的日志
  STATE.connectToken += 1;     // 让旧任务作废
  return true;
}

/** 移除一个设备会话并释放其资源 */
async function removeSession(id) {
  const s = STATE.sessions.find((x) => x.id === id);
  if (s) {
    if (s.hdc) { try { s.hdc.abort('断开设备'); } catch { /* ignore */ } }
    if (s.adb) { try { await s.adb.close(); } catch { /* ignore */ } }
    if (s.hdc) { try { await s.hdc.close(); } catch { /* ignore */ } }
  }
  STATE.sessions = STATE.sessions.filter((x) => x.id !== id);
  if (STATE.activeId === id) {
    const next = STATE.sessions[STATE.sessions.length - 1];
    if (next) { setActive(next.id); }
    else {
      STATE.activeId = null; STATE.kind = null; STATE.adb = null;
      STATE.hdc = null; STATE.device = null; STATE.info = null;
    }
  }
}

/**
 * 串行化连接：同一时刻只允许一个连接流程在跑。
 * 并发连接会让两个握手在同一设备上互相 RESET，双方都收不到应答。
 */
async function withConnectLock(fn) {
  if (STATE.connectInFlight) {
    try { await STATE.connectInFlight; } catch { /* 前一个失败无所谓 */ }
  }
  const run = (async () => fn())();
  STATE.connectInFlight = run.finally(() => {
    if (STATE.connectInFlight === run) { STATE.connectInFlight = null; }
  });
  return run;
}

/**
 * 后台保活：Chrome 会在标签页隐藏一段时间后冻结定时器，导致宿主桥停止轮询。
 * 播放一段几乎无声的 AudioContext 可以显著延缓冻结（业界常用做法）。
 * 必须在用户手势里首次调用。
 */
function startKeepAlive() {
  if (STATE.keepAlive) { return; }
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { return; }
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.00005;          // 几乎无声
    osc.frequency.value = 40;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    STATE.keepAlive = { ctx, osc };
    pushHdcLog('INFO', '已启用后台保活（阻止标签页被冻结）');
  } catch { /* 不支持就算了 */ }
}

/**
 * 释放残留的设备句柄。
 *
 * WebUSB 的 device 句柄挂在浏览器进程里。上一次连接（尤其是大文件传输超时）
 * 如果没走到 device.close()，页面销毁也不会自动关，句柄就一直 open，
 * 之后每次 open() 都报 Access denied —— 这就是反复连不上的真正原因。
 *
 * 所以连接前，把所有 getDevices() 里 opened=true 的设备强制 close 一遍。
 */
/** 把当前 WebUSB 的真实状态写进宿主日志，便于在不依赖用户复制的情况下定位问题 */
async function dumpUsbState(tag) {
  if (typeof navigator === 'undefined' || !navigator.usb) { return; }
  const report = { tag, at: new Date().toISOString(), devices: [], error: null };
  try {
    const list = await navigator.usb.getDevices();
    report.count = list.length;
    for (const d of list) {
      report.devices.push({
        vid: '0x' + d.vendorId.toString(16),
        pid: '0x' + d.productId.toString(16),
        serial: d.serialNumber || '',
        opened: !!d.opened,
        productName: d.productName || '',
        configuration: d.configuration ? d.configuration.configurationValue : null,
        interfaces: d.configuration
          ? d.configuration.interfaces.map((i) => ({
              n: i.interfaceNumber,
              cls: '0x' + i.alternate.interfaceClass.toString(16),
              claimed: !!i.claimed,
            }))
          : null,
      });
    }
  } catch (e) { report.error = String((e && e.message) || e); }
  // 直接 POST 到宿主（同源），宿主机写 ~/.dsh/usbstate.log
  try {
    await fetch('/mbridge/agc/usbstate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
    });
  } catch { /* ignore */ }

  // 分析：是否有 HDC 的 vendor 接口(0xff)
  const classes = [];
  for (const d of report.devices) {
    for (const i of (d.interfaces || [])) { classes.push(i.cls); }
  }
  report.classes = classes;
  report.hasHdcIface = classes.indexOf('0xff') >= 0;
  return report;
}

async function releaseStaleUsbHandles() {
  if (typeof navigator === 'undefined' || !navigator.usb) { return 0; }
  let n = 0;
  try {
    const list = await navigator.usb.getDevices();
    // 跳过已连接（sessions 里）的设备，多设备时不能把它们关掉
    const inUse = new Set();
    for (const s of STATE.sessions) {
      const sn = s.device && (s.device.serialNumber || s.device.serial);
      if (sn) { inUse.add(sn); }
    }
    if (STATE.device) { inUse.add(STATE.device.serialNumber || STATE.device.serial); }
    for (const d of list) {
      if (d.opened && !inUse.has(d.serialNumber || d.serial)) {
        try {
          await d.close();
          n += 1;
          pushHdcLog('INFO', `已释放残留的设备句柄 ${d.serialNumber || ''}`);
        } catch (e) {
          pushHdcLog('INFO', `释放残留句柄失败：${(e && e.message) || e}`);
        }
      }
    }
  } catch { /* ignore */ }
  return n;
}

/**
 * USB 掉线自愈：WebUSB 的 transfer 抛错后句柄即失效，此时用 getDevices() 取已授权设备
 * 重新走一遍连接（密钥已保存，通常无需上机确认）。
 */
/** Android 断线自愈：用 getDevices() 取已授权设备重新 attach（不需要用户手势） */
async function tryReconnectAdb() {
  const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
  if (!manager) { return false; }
  try {
    const list = await manager.getDevices();
    const want = STATE.info && STATE.info.serial;
    const dev = (want && list.find((d) => d.serial === want)) || list[0];
    if (!dev) { return false; }
    pushHdcLog('ADB', 'USB 句柄失效，尝试自动重连');
    const next = await attach(dev);
    STATE.kind = 'adb';
    STATE.info = next;
    registerCurrentSession();   // ★ 更新 sessions
    pushHdcLog('ADB', '自动重连成功');
    return true;
  } catch (e) {
    pushHdcLog('ADB', `自动重连失败：${(e && e.message) || e}`);
    return false;
  }
}

/** 按当前平台重连 */
async function tryReconnectAny() {
  if (STATE.kind === 'hdc') { return tryReconnectHdc(); }
  if (STATE.kind === 'adb') { return tryReconnectAdb(); }
  return false;
}

async function tryReconnectHdc() {
  if (typeof navigator === 'undefined' || !navigator.usb) { return false; }
  try {
    const list = await navigator.usb.getDevices();
    // 多设备：必须按当前活跃设备的 serial 找，不能取第一个（否则会重连到另一台）
    const wantSerial = STATE.device && (STATE.device.serialNumber || STATE.device.serial);
    const dev = (wantSerial && list.find((d) => d.vendorId === 0x12d1 && (d.serialNumber || d.serial) === wantSerial))
      || list.find((d) => d.vendorId === 0x12d1);
    if (!dev) { return false; }
    pushHdcLog('INFO', 'USB 句柄失效，尝试自动重连');
    const next = await withConnectLock(async () => {
      const token = ++STATE.connectToken;
      if (STATE.hdc) { try { STATE.hdc.abort('掉线重连'); } catch { /* ignore */ } STATE.hdc = null; }
      return connectHarmony(dev, token);
    });
    STATE.info = next;
    STATE.kind = 'hdc';
    registerCurrentSession();   // ★ 更新 sessions 里的会话引用，否则切设备会用到失效的旧会话
    pushHdcLog('INFO', '自动重连成功');
    return true;
  } catch (e) {
    pushHdcLog('INFO', `自动重连失败：${(e && e.message) || e}`);
    return false;
  }
}

const AGC_API = '/mbridge/agc';

/** 发起华为账号扫码登录（宿主起真实浏览器，我们显示二维码） */
async function agcStartLogin() {
  STATE.agc = { state: 'loading', qr: '', message: '正在打开华为登录页…' };
  try {
    const r = await fetch(AGC_API + '/login/start', { method: 'POST' });
    const d = await r.json();
    STATE.agc = {
      state: d.state || (d.ok ? 'waiting' : 'failed'),
      qr: d.qr || '',
      message: d.message || d.error || '',
      url: d.url || '',
    };
    startAgcPolling();
  } catch (e) {
    STATE.agc = { state: 'failed', qr: '', message: String(e && e.message ? e.message : e) };
  }
}

let agcPollTimer = null;
function startAgcPolling() {
  if (agcPollTimer) { return; }
  agcPollTimer = setInterval(async () => {
    if (STATE.agc.state !== 'waiting' && STATE.agc.state !== 'loading') {
      clearInterval(agcPollTimer);
      agcPollTimer = null;
      return;
    }
    try {
      const r = await fetch(AGC_API + '/login/status');
      const d = await r.json();
      STATE.agc = {
        state: d.state || STATE.agc.state,
        qr: d.qr || STATE.agc.qr,
        message: d.message || '',
        cookieCount: d.cookieCount,
        phase: d.phase || 'waiting',
        qrLeft: d.qrLeft,
      };
    } catch { /* 忽略单次失败 */ }
  }, 3000);
}

/** 从宿主读取已保存的登录态（插件重载/切页后自动恢复，不需要重新登录） */
async function agcRestoreSession() {
  try {
    const r = await fetch(AGC_API + '/session');
    const d = await r.json();
    if (d.present) {
      STATE.agc = {
        state: 'success', qr: '', message: '',
        savedAt: d.savedAt, cookieCount: d.cookieCount,
      };
    } else if (!STATE.agc || STATE.agc.state === 'idle') {
      STATE.agc = { state: 'idle', qr: '', message: '' };
    }
  } catch { /* 宿主不可达时保持原状 */ }
}

async function agcClearSession() {
  try {
    const r = await fetch(AGC_API + '/login/close', { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    STATE.agc = {
      state: 'idle', qr: '', mode: 'qr',
      message: d && d.removed
        ? '已清除登录态（本机凭证已删除），下次登录需要重新扫码'
        : '已关闭登录会话（本机没有凭证文件）',
    };
  } catch (e) {
    STATE.agc = { state: 'failed', qr: '', message: '清除失败：' + String(e && e.message ? e.message : e) };
    return;
  }
  agcPollTimer && clearInterval(agcPollTimer);
  agcPollTimer = null;
}

/** 把 HDC 日志送到宿主写文件，便于直接读取而不必截屏。 */
async function flushHdcLog() {
  const conn = STATE.connection;
  if (!conn || !STATE.log || !STATE.log.length) { return; }
  try {
    await conn.rpc.call(BRIDGE, EP + '/log', { lines: STATE.log });
  } catch { /* 日志上报失败不影响主流程 */ }
}

/** Android 侧日志：与 HDC 用同一份面板日志，前缀区分 */
function pushAdbLog(text) { pushHdcLog('ADB', text); }

function pushHdcLog(dir, text) {
  const d = new Date();
  const ts = String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0') + ':' +
    String(d.getSeconds()).padStart(2, '0') + '.' +
    String(d.getMilliseconds()).padStart(3, '0');
  STATE.log.push(`${ts} ${dir} ${text}`);
  if (STATE.log.length > 400) { STATE.log.shift(); }
  // 实时推到面板，用户能看到"请在手机上点允许"这类提示
  if (STATE.notify) { try { STATE.notify(STATE.log.join('\n')); } catch { /* ignore */ } }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    const adb = STATE.adb;
    const hdc = STATE.hdc;
    STATE.adb = null;
    STATE.hdc = null;
    STATE.device = null;
    STATE.info = null;
    STATE.kind = null;
    if (adb) { try { adb.close(); } catch { /* best effort */ } }
    if (hdc) { try { hdc.close(); } catch { /* best effort */ } }
  });
}

async function readInfo(adb, device) {
  const prop = async (key) => { try { return await adb.getProp(key); } catch { return ''; } };
  return {
    serial: device.serial,
    vendorId: device.raw.vendorId,
    productId: device.raw.productId,
    model: await prop('ro.product.model'),
    android: await prop('ro.build.version.release'),
  };
}

/** 建立连接并认证；成功后写入模块级 STATE。 */
async function attach(device) {
  pushAdbLog(`=== Android 连接开始 build=${BUILD_TAG} serial="${device.serial || ''}" ===`);
  const connection = await device.connect();
  pushAdbLog('USB 已连接，开始 ADB 认证');
  const credentialStore = new AdbWebCredentialStore('dsh-mobile-bridge');
  const transport = await AdbDaemonTransport.authenticate({
    serial: device.serial,
    connection,
    credentialStore,
  });
  const adb = new Adb(transport);
  pushAdbLog('ADB 认证完成');
  const info = await readInfo(adb, device);
  if (!info.model) { info.model = device.productName || ''; }
  if (!info.serial) { info.serial = device.serialNumber || device.serial || ''; }
  info.sysVersion = info.android ? ('Android ' + info.android) : 'Android';
  pushAdbLog(`机型=${info.model || '?'} Android=${info.android || '?'}`);
  STATE.adb = adb;
  STATE.device = device;
  STATE.info = info;
  STATE.kind = 'adb';        // 关键：registerCurrentSession 依赖 kind
  return info;
}

async function detach() {
  const adb = STATE.adb;
  const hdc = STATE.hdc;
  STATE.adb = null;
  STATE.hdc = null;
  STATE.device = null;
  STATE.info = null;
  STATE.kind = null;
  if (hdc) { try { hdc.abort('主动断开'); } catch { /* ignore */ } }
  if (adb) { try { await adb.close(); } catch { /* ignore */ } }
  if (hdc) { try { await hdc.close(); } catch { /* ignore */ } }
}

/**
 * 连接 HarmonyOS 设备（HDC over WebUSB）。
 *
 * 与 Android 分支的关键差别：
 *   · 不走 Tango，走自研 HdcTransport/HdcSession（协议来自真机抓包）
 *   · 首次要现场生成 RSA-3072 密钥对并用它应答 daemon 的 AUTH
 *   · 连上后先跑一条 param get 拿型号，作为面板展示信息
 */
async function connectHarmony(device, token) {
  const attempt = async (dev) => {
    checkToken();
    // 作废任何残留会话（包括自动重连留下的），否则它的心跳会一直写进端点，
    // 干扰本次握手（真机日志里出现过"认证前就发心跳"的现象）。
    if (STATE.hdcPending && STATE.hdcPending !== STATE.hdc) {
      try { STATE.hdcPending.abort('被新连接取代'); } catch { /* ignore */ }
    }
    STATE.hdcPending = null;
    STATE.log = [];
    pushHdcLog('INFO', `=== 尝试连接开始 build=${BUILD_TAG} serial=${JSON.stringify(dev.serialNumber || '')} ===`);
    await flushHdcLog();          // 先落一条，确保宿主侧能看到"这次确实跑了"
    const t = new HdcTransport(dev, { logger: pushHdcLog });
    try {
      return await connectHarmonyInner(t, dev, token);
    } catch (e) {
      // 失败必须释放：否则设备句柄留在 open 状态，之后每次 claim 都会失败
      try { await t.close(); } catch { /* ignore */ }
      throw e;
    }
  };

  const checkToken = () => {
    if (typeof token === 'number' && STATE.connectToken !== token) {
      throw new Error('已被新的连接操作取代，本次放弃');
    }
  };

  // 失败自愈：换一个全新的 USBDevice 引用重试（旧引用在 close 后可能失效）
  const RETRYABLE = /claim|Unable|NetworkError|disconnect|in use|busy|open|Access denied|SecurityError|not allowed/i;
  let lastErr = null;
  let dev = device;
  for (let i = 0; i < 3; i++) {
    try {
      return await attempt(dev);
    } catch (e) {
      lastErr = e;
      const raw = String(e && e.message ? e.message : e);
      if (!RETRYABLE.test(raw)) { throw e; }
      if (i === 2) { break; }
      pushHdcLog('INFO', `连接失败，${800 * (i + 1)}ms 后换新的设备引用重试（第 ${i + 2}/3 次）`);
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
      const list = await navigator.usb.getDevices().catch(() => []);
      const fresh = list.find((d) => d.vendorId === 0x12d1
        && (!device.serialNumber || d.serialNumber === device.serialNumber));
      if (fresh) { dev = fresh; }
    }
  }
  throw lastErr;
}

async function connectHarmonyInner(t, device, token) {
  t.emit('INFO', `vid=0x${device.vendorId.toString(16)} pid=0x${device.productId.toString(16)} `
    + `serial="${device.serialNumber || ''}" 版本=${DAEMON_VERSION}`); 
  // 密钥：复用浏览器里保存的（同一把只授权一次），没有就生成并保存
  let keyPair = null;
  let publicKeyPem = null;
  const stored = readStoredHdcKey();
  if (stored) {
    try {
      const imported = await importHdcKey(stored);
      keyPair = { privateKey: imported.privateKey };
      publicKeyPem = imported.publicKeyPem;
      t.emit('INFO', '复用浏览器已保存的密钥');
    } catch (e) {
      t.emit('INFO', `已保存的密钥不可用（${(e && e.message) || e}），改为新生成`);
    }
  }
  if (!keyPair) {
    keyPair = await generateKeyPair();
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
    let bin = '';
    for (const c of pkcs8) { bin += String.fromCharCode(c); }
    const b64 = btoa(bin).replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
    const pem = '-----BEGIN ' + 'PRIVATE KEY' + '-----\n' + b64 + '\n'
      + '-----END ' + 'PRIVATE KEY' + '-----\n';
    const saved = storeHdcKey(pem);
    t.emit('INFO', `已生成并保存 RSA-3072 密钥（${saved ? '已存入浏览器' : '仅本次有效'}）`);
  }
  const hostname = (typeof location !== 'undefined' && location.hostname) ? location.hostname : 'dsh-web';
  const session = new HdcSession(t, {
    serial: device.serialNumber || '',
    hostname,
    keyPair,
    publicKeyPem,
  });
  STATE.hdcPending = session;
  let authText;
  try {
    authText = await session.connect();
  } catch (e) {
    t.emit('ERROR', `握手/连接异常：${(e && e.message) || e}`);
    try { session.abort('连接失败'); } catch { /* ignore */ }
    if (STATE.hdcPending === session) { STATE.hdcPending = null; }
    throw e;
  }
  if (STATE.hdcPending === session) { STATE.hdcPending = null; }

  // 机型/系统：多个候选参数依次尝试（不同版本参数名不同），并过滤掉报错行
  const probe = async (keys) => {
    for (const key of keys) {
      try {
        if (STATE.connectToken !== token) { return ''; }
        const r = await session.shell(`param get ${key}`, { timeoutMs: 6000, attempts: 3 });
        const lines = String(r.text || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
        const val = lines.filter((l) => !l.includes('param get')).pop() || '';
        if (val && !/^\[?E\d/.test(val) && !/^error/i.test(val)) { return val; }
      } catch { /* 换下一个 */ }
    }
    return '';
  };
  // 连接刚建立时设备侧 shell 服务可能还没就绪（抓包显示真 hdc 会等 ~4 秒），
  // 所以这里先预热 + 多轮重试，直到取到机型为止。
  // 注意：探测失败**不应**导致连接失败——模型/API 只是展示信息。
  let model = '';
  let api = '';
  let osRelease = '';     // 系统主版本号，例如 7.0.0.111
  let online = '';
  try {
    for (let round = 1; round <= 5; round++) {
      if (STATE.connectToken !== token) { break; }
      model = await probe(['const.product.model', 'const.product.name', 'const.product.brand']);
      if (model) {
        api = await probe(['const.ohos.apiversion']);
        // 系统版本号：const.ohos.fullname 形如 OpenHarmony-7.0.0.111 → 取 7.0.0.111
        const fullname = await probe(['const.ohos.fullname']);
        const mv = String(fullname || '').match(/(\d+\.\d+\.\d+(?:\.\d+)?)/);
        osRelease = mv ? mv[1] : '';
        if (!osRelease) {
          // 兜底：const.product.software.version 形如 "PLA-AL10 7.0.0.111(SP12C00E111R9P3)"
          const soft = await probe(['const.product.software.version']);
          const m2 = String(soft || '').match(/(\d+\.\d+\.\d+(?:\.\d+)?)/);
          osRelease = m2 ? m2[1] : '';
        }
        online = await probe(['const.product.devicetype']);
        break;
      }
      t.emit('INFO', `机型探测第 ${round}/5 轮未取到，1.5 秒后重试`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (e) {
    t.emit('INFO', `设备信息探测失败（不影响连接）：${(e && e.message) || e}`);
  }
  t.emit('INFO', `探测结果 机型=${model || '?'} 版本=${osRelease || '?'} API=${api || '?'} 类型=${online || '?'}`);

  STATE.hdc = session;
  STATE.hdcPending = null;
  STATE.device = device;
  STATE.kind = 'hdc';
  STATE.info = {
    kind: 'hdc',
    serial: device.serialNumber || '',
    vendorId: device.vendorId,
    productId: device.productId,
    model: model
      || ((device.productName && !/HDC|Interface/i.test(device.productName)) ? device.productName : '')
      || 'HarmonyOS 设备',
    os: api ? `HarmonyOS (API ${api})` : 'HarmonyOS',
    sysVersion: osRelease ? `HarmonyOS ${osRelease}` : (api ? `HarmonyOS (API ${api})` : 'HarmonyOS'),
    devtype: online,
    auth: authText.split('\n').filter(Boolean).slice(-1)[0] || '',
  };
  return STATE.info;
}

/** 统一执行一条 shell 命令（ADB 或 HDC）。 */
/**
 * 截图：ADB 用 screencap，HDC 用 snapshot_display + base64 读回。
 * 返回 { bytes, mime }。
 */
async function captureScreen() {
  if (STATE.kind === 'hdc' && STATE.hdc) {
    const s = STATE.hdc;
    const path = `/data/local/tmp/dsh_shot_${Date.now()}.jpeg`;
    pushHdcLog('INFO', `截图：snapshot_display → ${path}`);
    const r1 = await s.shell(`snapshot_display -f ${path}`, { timeoutMs: 20000, attempts: 1 });
    pushHdcLog('INFO', `snapshot_display 输出: ${JSON.stringify(String(r1.text || '').slice(0, 120))}`);

    const rLs = await s.shell(`ls -l ${path}`, { timeoutMs: 8000, attempts: 1 });
    pushHdcLog('INFO', `ls -l: ${JSON.stringify(String(rLs.text || '').slice(0, 160))}`);

    let b64 = '';
    for (const cmd of [`base64 ${path}`, `base64 -w0 ${path}`, `cat ${path} | base64`]) {
      const r = await s.shell(cmd, { timeoutMs: 90000, attempts: 1 });
      const cand = String(r.text || '').replace(/[^A-Za-z0-9+/=]/g, '');
      pushHdcLog('INFO', `${cmd} → ${cand.length} 字符`);
      if (cand.length > 1000) { b64 = cand; break; }
    }
    s.shell(`rm -f ${path}`, { timeoutMs: 8000, attempts: 1 }).catch(() => {});
    if (!b64) {
      throw new Error('截图文件读回为空。'
        + `snapshot 输出=${JSON.stringify(String(r1.text || '').slice(0, 80))}；`
        + `ls -l=${JSON.stringify(String(rLs.text || '').slice(0, 80))}`);
    }
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) { bytes[i] = bin.charCodeAt(i); }
    return { bytes, mime: 'image/jpeg' };
  }

  const adb = STATE.adb;
  if (!adb) { throw new Error('未连接设备'); }
  const bytes = await adb.subprocess.noneProtocol.spawnWait('screencap -p');
  return { bytes, mime: 'image/png' };
}

async function execShell(cmd) {
  if (STATE.kind === 'hdc' && STATE.hdc) {
    const r = await STATE.hdc.shell(cmd);
    return '$ ' + cmd + '\n' + (r.text || '');
  }
  if (STATE.adb) {
    return runShellText(STATE.adb, cmd);
  }
  throw new Error('未连接设备');
}

async function runShellText(adb, cmd) {
  const sp = adb.subprocess.shellProtocol;
  if (sp) {
    const r = await sp.spawnWaitText(cmd);
    return (
      '$ ' + cmd + '\n' +
      (r.stdout || '') +
      (r.stderr ? '\n[stderr] ' + r.stderr : '') +
      '\n[exit ' + r.exitCode + ']'
    );
  }
  const text = await adb.subprocess.noneProtocol.spawnWaitText(cmd);
  return '$ ' + cmd + '\n' + text;
}

function fromBase64(b64) {
  const bin = atob(String(b64 || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
  return out;
}

function toBase64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 浏览器可达的 RPC 只有共享 /api 通道；宿主用 intercept 接管这些端点。
const BRIDGE = '/api';
const EP = 'mobile-bridge';

/** 桥接诊断：面板会显示，console 也会打，避免"静默失败"。 */
const DIAG = { state: 'init', polls: 0, lastOk: 0, error: null, injected: null };
const POLL_INTERVAL_MS = 1500;

/** 执行一条宿主派下来的任务。 */
/**
 * 执行一个桥接任务。push/pull/install/uninstall 按当前平台分派到 HDC 或 ADB 实现。
 */
async function doTransferJob(job) {
  const log = (m) => pushHdcLog('INFO', m);
  const kind = job.kind;
  const d = job.data;
  const bytes = (d && d.base64) ? fromBase64(d.base64) : null;

  if (kind === 'push') {
    if (STATE.hdc) {
      // 分片模式：只写这一块（幂等，精确偏移）
      if (typeof d.index === 'number' && d.chunkSize) {
        const r = await writeChunkAt(STATE.hdc, d.path, bytes, d.chunkSize, d.index, { log });
        return { ok: true, bytes: r.bytes, chunk: d.index };
      }
      log(`开始上传 ${bytes.length} 字节 → ${d.path}`);
      const r = await pushFile(STATE.hdc, d.path, bytes, { log });
      return { ok: true, bytes: r.bytes, chunks: r.chunks };
    }
    if (STATE.adb) {
      log(`开始上传 ${bytes.length} 字节 → ${d.path}`);
      const r = await pushFileAdb(STATE.adb, d.path, bytes, { log });
      return { ok: true, bytes: r.bytes };
    }
    return { ok: false, error: '未连接设备' };
  }

  if (kind === 'pull') {
    if (STATE.hdc) {
      log(`开始下载 ${d.path}`);
      const r = await pullFile(STATE.hdc, d.path, { log });
      return { ok: true, bytes: r.bytes.length, base64: toBase64(r.bytes) };
    }
    if (STATE.adb) {
      log(`开始下载 ${d.path}`);
      const r = await pullFileAdb(STATE.adb, d.path, { log });
      return { ok: true, bytes: r.bytes.length, base64: toBase64(r.bytes) };
    }
    return { ok: false, error: '未连接设备' };
  }

  if (kind === 'install') {
    if (STATE.hdc) {
      log(`开始安装 ${d.filename}（${bytes.length} 字节）`);
      const r = await installHap(STATE.hdc, { bytes, filename: d.filename, replace: !!d.replace }, { log });
      return { ok: true, output: r.output };
    }
    if (STATE.adb) {
      log(`开始安装 APK ${d.filename}（${bytes.length} 字节）`);
      const r = await installApkAdb(STATE.adb, { bytes, filename: d.filename, replace: !!d.replace }, { log });
      return { ok: true, output: r.output };
    }
    return { ok: false, error: '未连接设备' };
  }

  if (kind === 'uninstall') {
    if (STATE.hdc) { return { ok: true, output: await uninstallBundle(STATE.hdc, d.bundle) }; }
    if (STATE.adb) { return { ok: true, output: await uninstallPackageAdb(STATE.adb, d.bundle) }; }
    return { ok: false, error: '未连接设备' };
  }

  return { ok: false, error: '未知任务类型 ' + kind };
}

async function runJob(job) {
  if (!STATE.adb && !STATE.hdc) { return { ok: false, error: '浏览器端尚未连接设备（请在设置页点「连接设备」）' }; }
  const token = STATE.connectToken;
  const stale = () => STATE.connectToken !== token;
  try {
    if (job.kind === 'shell') {
      const output = await execShell(job.data.cmd);
      if (stale()) { return { ok: false, error: '连接已切换，任务作废' }; }
      return { ok: true, output };
    }
    if (job.kind === 'screenshot') {
      const shot = await captureScreen();
      if (stale()) { return { ok: false, error: '连接已切换，任务作废' }; }
      if (shot.bytes.length > 12 * 1024 * 1024) {
        return { ok: false, error: `截图过大（${shot.bytes.length} 字节），未回传` };
      }
      return { ok: true, base64: toBase64(shot.bytes), mime: shot.mime };
    }
    if (job.kind === 'activate') {
      const id = String(job.data && job.data.id || '');
      const ok = setActive(id);
      if (!ok) { return { ok: false, error: '没有这个设备：' + id }; }
      return { ok: true, output: '已切换到 ' + id, activeId: id };
    }
    if (job.kind === 'push' || job.kind === 'pull' || job.kind === 'install' || job.kind === 'uninstall') {
      const r = await doTransferJob(job);
      if (stale() && r.ok) { return { ok: false, error: '连接已切换，任务作废' }; }
      return r;
    }
    return { ok: false, error: '未知任务类型 ' + job.kind };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    // USB 掉线：按平台自动重连，然后重试同一任务一次
    if (/transferIn|transferOut|USBDevice|disconnect|lost|No device|socket|closed/i.test(msg) && !stale()) {
      const ok = await tryReconnectAny();
      if (ok) {
        try {
          if (job.kind === 'shell') { return { ok: true, output: await execShell(job.data.cmd) }; }
          if (job.kind === 'screenshot') {
            const shot = await captureScreen();
            return { ok: true, base64: toBase64(shot.bytes), mime: shot.mime };
          }
          return await doTransferJob(job);
        } catch (e2) {
          return { ok: false, error: `重连后重试仍失败：${String(e2 && e2.message ? e2.message : e2)}` };
        }
      }
    }
    return { ok: false, error: msg };
  }
}

function startBridge(connection) {
  STATE.connection = connection;
  let stopped = false;
  DIAG.state = 'polling';

  // 任务队列：轮询只负责"取任务入队"，执行交给独立 runner 串行跑。
  // 关键：绝不能在轮询循环里 await 长任务（pm install 等待弹窗、大文件传输等），
  // 否则整条轮询会停摆，宿主会判定"浏览器没有在轮询"，连心跳都没了。
  const queue = [];
  let running = false;

  async function runner() {
    if (running) { return; }
    running = true;
    while (queue.length && !stopped) {
      const job = queue.shift();
      let outcome;
      try {
        // 任务级超时兜底：任何单个任务最多 6 分钟，超时后放弃，绝不无限堵队列
        outcome = await Promise.race([
          runJob(job),
          new Promise((_, rej) => setTimeout(
            () => rej(new Error('任务超时（6 分钟），已放弃')), 360000)),
        ]);
      } catch (e) {
        outcome = { ok: false, error: String(e && e.message ? e.message : e) };
      }
      try {
        await connection.rpc.call(BRIDGE, EP + '/result', Object.assign({ id: job.id }, outcome));
      } catch { /* 宿主可能已超时，忽略 */ }
    }
    running = false;
  }

  (async () => {
    while (!stopped) {
      const started = Date.now();
      try {
        const res = await connection.rpc.call(BRIDGE, EP + '/poll', {
          device: STATE.info
            ? { model: STATE.info.model, android: STATE.info.android, os: STATE.info.os, kind: STATE.kind, serial: STATE.info.serial }
            : null,
          devices: (STATE.sessions || []).map((x) => ({
            id: x.id, kind: x.kind,
            model: x.info && x.info.model || '',
            serial: x.info && x.info.serial || '',
            active: x.id === STATE.activeId,
          })),
          activeId: STATE.activeId,
          log: STATE.log && STATE.log.length ? STATE.log.slice(-80) : undefined,
          state: STATE.info ? 'connected' : (STATE.lastConnectError ? 'failed' : ((STATE.hdcPending || STATE.connectInFlight) ? 'connecting' : 'idle')),
          lastError: STATE.lastConnectError || null,
          build: BUILD_TAG,
        });
        DIAG.polls += 1;
        DIAG.lastOk = Date.now();
        DIAG.error = null;
        if (res && res.ok && res.value && res.value.job) {
          // 只入队，不等待执行
          if (queue.length < 32) { queue.push(res.value.job); }
          runner();
        }
      } catch (e) {
        DIAG.error = String(e && e.message ? e.message : e);
        if (DIAG.polls === 0 || DIAG.polls % 20 === 0) {
          console.warn('[mobile-bridge] poll failed:', e);
        }
      }
      await sleep(Math.max(0, POLL_INTERVAL_MS - (Date.now() - started)));
    }
  })();
  return () => { stopped = true; };
}

const CSS = `
.mb-root { display: flex; flex-direction: column; gap: 14px; font-size: 13px; }
.mb-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
/* 用 !important 压掉宿主全局 button 样式：否则 disabled 时会被改成白底白字 */
.mb-root .mb-btn {
  padding: 7px 14px !important; border-radius: 8px !important;
  border: 1px solid rgba(127,127,127,.45) !important;
  background: rgba(127,127,127,.18) !important;
  color: inherit !important;
  font-size: 13px !important; cursor: pointer !important; font-family: inherit !important;
  line-height: 1.5 !important;
}
.mb-root .mb-btn:hover:not(:disabled) { border-color: #3b82f6 !important; }
.mb-root .mb-btn:disabled {
  opacity: 1 !important; cursor: not-allowed !important;
  background: rgba(127,127,127,.10) !important;
  color: rgba(127,127,127,.95) !important;
}
.mb-root .mb-btn--primary {
  background: #3b82f6 !important; color: #fff !important;
  border-color: transparent !important;
}
.mb-root .mb-btn--primary:disabled {
  background: rgba(59,130,246,.55) !important;
  color: #fff !important;
}
.mb-card {
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35)); border-radius: 10px;
  padding: 12px 14px; background: var(--dsw-alias-fill-l1, rgba(127,127,127,.08));
}
.mb-kv { display: grid; grid-template-columns: 92px 1fr; row-gap: 4px; }
.mb-k { color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.95)); }
.mb-v { color: var(--dsw-alias-label-primary, inherit); word-break: break-all; }
.mb-note { color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.95)); line-height: 1.6; }
.mb-err { color: var(--dsw-alias-label-error, #d9534f); white-space: pre-wrap; line-height: 1.6; }
.mb-input {
  flex: 1; min-width: 220px; padding: 7px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.45));
  background: var(--dsw-alias-bg-l1, transparent); color: var(--dsw-alias-label-primary, inherit);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;
}
.mb-out {
  margin: 0; padding: 10px; border-radius: 8px; max-height: 260px; overflow: auto;
  background: var(--dsw-alias-fill-l2, rgba(127,127,127,.16)); color: var(--dsw-alias-label-primary, inherit);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px; white-space: pre-wrap; word-break: break-all;
}
.mb-badge {
  display: inline-block; padding: 1px 8px; border-radius: 9px; font-size: 11px; line-height: 18px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.45)); color: var(--dsw-alias-label-secondary, rgba(127,127,127,.95));
}
`;

/**
 * 华为账号登录（独立设置页）
 *
 * 登录态由宿主持久化在 ~/.dsh/agc-session.json，页面挂载时自动恢复，
 * 所以插件重载、切页、重连手机都不需要重新登录。
 */
/** 构建「华为账号」面板（内嵌在移动设备页，与 Android / HarmonyOS 平级切换） */
function buildHuaweiAccountPanel(t) {
  const agc = STATE.agc || { state: 'idle' };
  const savedAtText = agc.savedAt ? new Date(agc.savedAt * 1000).toLocaleString() : '';
  const out = [];

  out.push(h('div', { key: 'acc-h', className: 'mb-card' },
    h('div', { className: 'mb-note', style: { lineHeight: 1.7 } }, t('accountHint')),

    h('div', { style: { marginTop: '10px' } },
      agc.state === 'success'
        ? h('div', { style: { color: '#22c55e', fontWeight: 600 } },
            '✅ ' + t('accountStatusOk')
            + (agc.cookieCount ? `（${agc.cookieCount} 条 Cookie）` : '')
            + (savedAtText ? `，登录于 ${savedAtText}` : ''))
        : h('div', { className: 'mb-note' }, t('accountStatusNone'))),

    h('div', { className: 'mb-row', style: { marginTop: '10px' } },
      h('button', { className: 'mb-btn mb-btn--primary', onClick: agcStartLogin },
        agc.state === 'success' ? t('accountRelogin') : t('agcLogin')),
      h('button', { className: 'mb-btn', onClick: agcClearSession }, t('agcLogout')),
    ),

    agc.state === 'loading'
      ? h('div', { className: 'mb-note', style: { marginTop: '10px' } }, agc.message || '正在打开…')
      : null,

    agc.state === 'waiting'
      ? h('div', { style: { marginTop: '10px' } },
          h('div', { className: 'mb-note' },
            (agc.phase === 'scanned' ? '✅ 已扫码，请在手机上点「确认登录」'
              : agc.phase === 'expired' ? '二维码已过期，正在自动刷新…'
              : (agc.message || t('agcWaiting')))
            + (typeof agc.qrLeft === 'number' ? `（约 ${agc.qrLeft} 秒后自动刷新）` : '')),
          (agc.qr && agc.qr.length > 2000)
            ? h('img', {
                src: 'data:image/png;base64,' + agc.qr,
                style: { display: 'block', marginTop: '8px', width: '290px', height: '290px', borderRadius: '6px', background: '#fff' },
              })
            : h('div', { className: 'mb-note' }, t('agcNoQr')),
          h('button', { className: 'mb-btn', style: { marginTop: '8px' }, onClick: agcStartLogin }, t('agcRefresh')),
        )
      : null,

    agc.state === 'failed'
      ? h('div', { className: 'mb-err', style: { marginTop: '10px' } },
          t('agcFailed') + (agc.message ? '：' + agc.message : ''))
      : null,
  ));

  out.push(h('div', { key: 'acc-p', className: 'mb-card' },
    h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, t('accountPersistTitle')),
    h('div', { className: 'mb-note', style: { lineHeight: 1.7 } }, t('accountPersistHint')),
  ));

  return out;
}

function MobileBridgeSection(props) {
  const t = props.t;
  const [view, setView] = React.useState('device');   // device | account（与 Android/HarmonyOS 平级）
  const [phase, setPhase] = React.useState((STATE.adb || STATE.hdc) ? 'connected' : 'idle');
  const [kind, setKind] = React.useState(STATE.kind || 'adb');
  const [showFullLog, setShowFullLog] = React.useState(false);
  const [channel, setChannel] = React.useState('web');   // web | cli
  const [cliTools, setCliTools] = React.useState(null);
  const [cliDevices, setCliDevices] = React.useState([]);
  const [cliActive, setCliActive] = React.useState(null);
  const [cliLog, setCliLog] = React.useState([]);
  const [cliBusy, setCliBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [info, setInfo] = React.useState(STATE.info);
  const [cmd, setCmd] = React.useState(
    (STATE.kind === 'hdc') ? 'param get const.product.model' : 'getprop ro.product.model',
  );
  const [out, setOut] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [agcAccount, setAgcAccount] = React.useState('');
  const [agcPassword, setAgcPassword] = React.useState('');
  const [agcCode, setAgcCode] = React.useState('');
  const [usbSupported] = React.useState(
    typeof navigator !== 'undefined' && !!navigator.usb,
  );
  // 诊断心跳：DIAG 是模块级对象，没有它面板不会重渲染
  const [, setTick] = React.useState(0);
  // 把一段文本追加到当前设备日志（STATE.log 即当前活跃设备的日志数组引用）
  function appendToLog(text) {
    try {
      if (!STATE.log) { STATE.log = []; }
      STATE.log.push(String(text));
      setTick((n) => n + 1);
    } catch { /* ignore */ }
  }
  React.useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 2000);
    STATE.notify = () => setTick((n) => n + 1);
    agcRestoreSession();      // 打开设置页就把已保存的华为登录态读回来
    return () => { clearInterval(id); if (STATE.notify) { STATE.notify = null; } };
  }, []);

  // 页面卸载时尽力关闭 USB 设备，避免句柄悬挂在浏览器进程里（下次连接会 Access denied）
  React.useEffect(() => {
    const onUnload = () => {
      try { if (STATE.hdc) STATE.hdc.close(); } catch { /* 同步尽力而为 */ }
      try {
        navigator.usb.getDevices().then((list) => {
          for (const d of list) { if (d.opened) { try { d.close(); } catch { /* ignore */ } } }
        }).catch(() => {});
      } catch { /* ignore */ }
    };
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('pagehide', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('pagehide', onUnload);
    };
  }, []);

  // 挂载时不做任何自动重连：曾经的后台自动重连会和用户点击抢锁、
  // 让 requestDevice 失去用户手势，是 Access denied / gesture 报错的根源之一。

  // ★★ 关键：requestDevice 必须在用户点击的同一个调用栈里**立刻**调用。
  //     绝不能先 await（包括等连接锁），否则浏览器判定"没有用户手势"，
  //     报 Must be handling a user gesture。这就是之前一直连不上的真正原因。
  // 统一的「连接设备」：不预设安卓/鸿蒙，选完设备后自动识别类型。
  async function connect() {
    setError('');
    if (typeof navigator === 'undefined' || !navigator.usb) { setError(t('noWebusb')); return; }
    const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
    let raw = null;
    try {
      // 华为设备的 ADB 与 HDC 都是 vendorId 0x12d1，用同一个选择器让用户直接选设备
      raw = await navigator.usb.requestDevice({ filters: [{ vendorId: 0x12d1 }] });
    } catch (e) {
      if (!e || e.name !== 'NotFoundError') {
        setError('选择设备失败：' + (e && e.message ? e.message : e));
      }
      return;
    }
    if (!raw) { setPhase((STATE.adb || STATE.hdc) ? 'connected' : 'idle'); return; }

    // 自动识别：该设备出现在 ADB 设备列表里 → 安卓；否则 → 鸿蒙（HDC 接口不是 ADB 标准接口）
    const serial = raw.serialNumber || raw.serial || '';
    let adbDev = null;
    if (manager) {
      try {
        const list = await manager.getDevices();
        adbDev = list.find((d) => d.serial === serial) || null;
      } catch { /* ignore */ }
    }
    const detected = adbDev ? 'adb' : 'hdc';
    setPhase('connecting');
    startKeepAlive();
    return withConnectLock(() => runConnect(detected === 'adb' ? adbDev : raw, detected));
  }

  async function runConnect(device, connKind) {
    // 多设备：先把当前活跃设备存进 sessions（不清空、不断开），再连接新设备
    syncActiveToSessions();
    // ★ 同一台设备（同 serial）重复连接时，必须先关闭旧会话释放它的 WebUSB claim，
    //   否则旧 HdcSession 还 claim 着接口，新连接必然 claim 失败，且要重启浏览器才恢复。
    try {
      const devSerial = device && (device.serialNumber || device.serial);
      if (devSerial) {
        const dup = STATE.sessions.filter((s) =>
          (s.info && s.info.serial === devSerial)
          || (s.device && (s.device.serialNumber || s.device.serial) === devSerial));
        for (const old of dup) {
          try { await removeSession(old.id); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    const token = ++STATE.connectToken;
    STATE.info = null;
    try {
      if (connKind === 'hdc') {
        // 清掉浏览器里残留的句柄（releaseStaleUsbHandles 会跳过 sessions 里在用的设备）
        await releaseStaleUsbHandles();
        const next = await connectHarmony(device, token);
        await flushHdcLog();
        setInfo(next);
        registerCurrentSession();
        setCmd('param get const.product.model');
        STATE.lastConnectError = null;
        setPhase('connected');
        return;
      }
      if (STATE.connectToken !== token) { return; }        // 期间已发起新连接
      const next = await attach(device);
      if (STATE.connectToken !== token) { return; }   // 连接被取代
      setInfo(next);
      registerCurrentSession();
      setCmd('getprop ro.product.model');
      STATE.lastConnectError = null;
      setPhase('connected');
    } catch (e) {
      const raw = String(e && e.message ? e.message : e);
      STATE.lastConnectError = raw;
      // 失败时把 USB 真实状态写进日志（我在宿主侧直接读，无需用户复制）
      let usbState = null;
      try { usbState = await dumpUsbState('连接失败后'); } catch { /* ignore */ }
      let hint = friendly(raw, t, connKind);
      // 精准诊断：设备在，但暴露的是 HID/其它接口，没有 HDC 的 0xff 接口
      if (usbState && usbState.count > 0 && usbState.hasHdcIface === false) {
        hint = '手机当前的 USB 接口不是 HDC 调试接口（现在暴露的是 class='
          + (usbState.classes.join('/') || '?')
          + '，HDC 需要 0xff）。\n\n解决办法（在手机上操作）：\n'
          + '1) 解锁手机，下拉通知栏 → 点「USB 连接方式」→ 选「传输文件」\n'
          + '   （或拔掉数据线重插，在手机弹出的选项里选「传输文件」）\n'
          + '2) 确认「设置 → 系统 → 开发者选项 → USB 调试」是打开的\n'
          + '3) 回到这里点「连接设备」\n\n'
          + '如果下拉通知栏没有 USB 选项：换一根数据线（有些线只能充电）。';
      }
      // 日志与原始错误在下面统一设置（并把日志复制到剪贴板）
      const logText = (STATE.log && STATE.log.length)
        ? STATE.log.join('\n')
        : '（本次未产生收发日志：说明失败发生在创建传输层之前）';
      try {
        // 方便用户直接粘贴给开发者：失败即把完整日志放进剪贴板
        await navigator.clipboard.writeText(logText);
        setError((hint ? (hint + '\n\n') : '') + '原始错误：' + raw
          + '\n\n完整收发日志已复制到剪贴板，直接 Ctrl+V 粘贴即可。');
      } catch {
        setError((hint ? (hint + '\n\n') : '') + '原始错误：' + raw);
      }
      await flushHdcLog();
      setPhase((STATE.adb || STATE.hdc) ? 'connected' : 'idle');
    }
  }

  async function disconnect() {
    if (STATE.activeId) {
      await removeSession(STATE.activeId);   // 只断当前这台，其他设备保留
    } else {
      await detach();
    }
    setInfo(STATE.info || null);
    if (!STATE.activeId) { setOut(''); setPhase('idle'); }
  }

  // ---- 本机 CLI 通道操作（走宿主 /mbridge/cli/*）----
  async function cliRefresh() {
    try {
      const r = await fetch('/mbridge/cli/status');
      const d = await r.json();
      setCliTools({ adb: d.adb, hdc: d.hdc, available: !!d.available });
      setCliDevices(d.devices || []);
      setCliActive(d.activeId || (d.devices && d.devices[0] && d.devices[0].id) || null);
    } catch (e) { setError('CLI 探测失败：' + (e && e.message ? e.message : e)); }
  }
  async function cliActivate(id) {
    try {
      await fetch('/mbridge/cli/activate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
      setCliActive(id);
    } catch { /* ignore */ }
  }
  async function cliExec() {
    if (!cmd || cliBusy) { return; }
    setCliBusy(true);
    try {
      const r = await fetch('/mbridge/cli/exec', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd, deviceId: cliActive, timeoutMs: 60000 }) });
      const d = await r.json();
      setCliLog((prev) => prev.concat([d.ok ? d.output : ('✗ 错误：' + (d.error || ''))]));
    } catch (e) {
      setCliLog((prev) => prev.concat(['✗ 错误：' + (e && e.message ? e.message : e)]));
    } finally { setCliBusy(false); }
  }
  async function cliShot() {
    if (cliBusy) { return; }
    setCliBusy(true);
    try {
      const r = await fetch('/mbridge/cli/screenshot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: cliActive }) });
      const d = await r.json();
      if (d.ok && d.base64) {
        const bin = atob(d.base64); const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) { arr[i] = bin.charCodeAt(i); }
        window.open(URL.createObjectURL(new Blob([arr], { type: d.mime || 'image/png' })), '_blank');
        setCliLog((prev) => prev.concat([`截图完成：${d.bytes} 字节`]));
      } else {
        setCliLog((prev) => prev.concat(['✗ 截图失败：' + (d.error || '')]));
      }
    } catch (e) {
      setCliLog((prev) => prev.concat(['✗ 截图失败：' + (e && e.message ? e.message : e)]));
    } finally { setCliBusy(false); }
  }

  async function runShell() {
    if (!STATE.adb && !STATE.hdc) { setPhase('idle'); return; }
    setBusy(true);
    setError('');
    const token = STATE.connectToken;
    try {
      const text = await execShell(cmd);
      if (STATE.connectToken !== token) { return; }   // 连接已切换，丢弃旧结果
      appendToLog(text);
    } catch (e) {
      const raw = String(e && e.message ? e.message : e);
      // 失败时把 USB 真实状态写进日志（我在宿主侧直接读，无需用户复制）
      let usbState = null;
      try { usbState = await dumpUsbState('连接失败后'); } catch { /* ignore */ }
      let hint = friendly(raw, t, kind);
      // 精准诊断：设备在，但暴露的是 HID/其它接口，没有 HDC 的 0xff 接口
      if (usbState && usbState.count > 0 && usbState.hasHdcIface === false) {
        hint = '手机当前的 USB 接口不是 HDC 调试接口（现在暴露的是 class='
          + (usbState.classes.join('/') || '?')
          + '，HDC 需要 0xff）。\n\n解决办法（在手机上操作）：\n'
          + '1) 解锁手机，下拉通知栏 → 点「USB 连接方式」→ 选「传输文件」\n'
          + '   （或拔掉数据线重插，在手机弹出的选项里选「传输文件」）\n'
          + '2) 确认「设置 → 系统 → 开发者选项 → USB 调试」是打开的\n'
          + '3) 回到这里点「连接设备」\n\n'
          + '如果下拉通知栏没有 USB 选项：换一根数据线（有些线只能充电）。';
      }
      // 日志与原始错误在下面统一设置（并把日志复制到剪贴板）
      const logText = (STATE.log && STATE.log.length)
        ? STATE.log.join('\n')
        : '（本次未产生收发日志：说明失败发生在创建传输层之前）';
      try {
        // 方便用户直接粘贴给开发者：失败即把完整日志放进剪贴板
        await navigator.clipboard.writeText(logText);
        setError((hint ? (hint + '\n\n') : '') + '原始错误：' + raw
          + '\n\n完整收发日志已复制到剪贴板，直接 Ctrl+V 粘贴即可。');
      } catch {
        setError((hint ? (hint + '\n\n') : '') + '原始错误：' + raw);
      }
      await flushHdcLog();
    } finally {
      setBusy(false);
    }
  }

  async function screenshot() {
    if (!STATE.adb && !STATE.hdc) { setPhase('idle'); return; }
    setBusy(true);
    setError('');
    const token = STATE.connectToken;
    try {
      const shot = await captureScreen();
      // 期间连接被切换 → 丢弃结果，避免把旧设备屏幕当成新设备
      if (STATE.connectToken !== token) { return; }
      const url = URL.createObjectURL(new Blob([shot.bytes], { type: shot.mime }));
      window.open(url, '_blank');
      pushHdcLog('INFO', `截图完成：${shot.bytes.length} 字节`);
    } catch (e) {
      const raw = String(e && e.message ? e.message : e);
      const hint = friendly(raw, t, kind);
      setError(hint ? (hint + '\n\n原始错误：' + raw) : '截图失败：' + raw);

    } finally {
      setBusy(false);
    }
  }

  const phaseLabel = {
    idle: t('stateIdle'),
    reconnecting: t('stateReconnecting'),
    connecting: t('connecting'),
    connected: t('stateConnected'),
  }[phase] || t('stateIdle');

  const children = [
    h('style', { key: 's' }, CSS),
    h('div', { key: 'row', className: 'mb-row' },
      h('button', {
        key: 'chweb',
        className: 'mb-btn' + (channel === 'web' ? ' mb-btn--primary' : ''),
        onClick: () => setChannel('web'),
      }, t('chWeb')),
      h('button', {
        key: 'chcli',
        className: 'mb-btn' + (channel === 'cli' ? ' mb-btn--primary' : ''),
        onClick: () => { setChannel('cli'); if (!cliDevices.length) { cliRefresh(); } },
      }, t('chCli')),
      h('button', {
        key: 'kacc',
        className: 'mb-btn' + (view === 'account' ? ' mb-btn--primary' : ''),
        onClick: () => setView('account'),
      }, t('navAccount') + (STATE.agc && STATE.agc.state === 'success' ? ' ✓' : '')),

      view === 'account' ? null : h('button', {
        key: 'diag',
        className: 'mb-btn',
        onClick: async () => {
          setError('');
          try {
            await dumpUsbState('诊断按钮');
            const d = await diagnoseUsb();
            appendToLog('USB 诊断：\n' + JSON.stringify(d, null, 2));
          } catch (e) {
            setError(String(e && e.message ? e.message : e));
          }
        },
      }, t('diagnose')),
      view === 'account' ? null : h('button', {
        key: 'c',
        className: 'mb-btn mb-btn--primary',
        disabled: phase === 'connecting' || !usbSupported,
        onClick: connect,
      }, phase === 'connecting' ? t('connecting') : t('connect')),
      view === 'account' ? null : (phase === 'connected'
        ? h('button', { key: 'd', className: 'mb-btn', onClick: disconnect }, t('disconnect'))
        : null),
      view === 'account' ? null : h('span', { key: 'b', className: 'mb-badge' }, phaseLabel),
      h('span', { key: 'build', className: 'mb-badge' }, BUILD_TAG),
    ),
  ];

  // 华为账号视图：只渲染账号面板（与设备视图平级切换）
  if (view === 'account') {
    for (const el of buildHuaweiAccountPanel(t)) { children.push(el); }
    children.push(h('div', { key: 'n2', className: 'mb-note' }, t('accountHintShort')));
    return h('div', { className: 'mb-root' }, children);
  }

  // ===== 本机 CLI 通道视图 =====
  if (channel === 'cli') {
    children.push(h('div', { key: 'cli', className: 'mb-card' },
      h('div', { className: 'mb-row' },
        h('button', { className: 'mb-btn mb-btn--primary', onClick: cliRefresh }, t('cliRefresh')),
        h('span', { className: 'mb-note' }, cliTools
          ? (cliTools.available
            ? ('adb ' + (cliTools.adb ? '✓' : '✗') + '  hdc ' + (cliTools.hdc ? '✓' : '✗'))
            : t('cliNotFound'))
          : ''),
      ),
      h('div', { style: { marginTop: '10px' } }, cliDevices.length
        ? cliDevices.map((d) => h('button', {
            key: d.id,
            className: 'mb-btn' + (d.id === cliActive ? ' mb-btn--primary' : ''),
            style: { marginRight: '8px', marginBottom: '6px' },
            onClick: () => cliActivate(d.id),
          }, (d.kind === 'hdc' ? '鸿蒙 ' : '安卓 ') + (d.model || d.serial)))
        : h('div', { className: 'mb-note' }, cliTools ? t('cliNoDev') : t('cliHint'))),
      h('div', { className: 'mb-row', style: { marginTop: '10px' } },
        h('input', {
          className: 'mb-input', value: cmd, spellCheck: false,
          onChange: (e) => setCmd(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter' && !cliBusy) { cliExec(); } },
        }),
        h('button', { className: 'mb-btn', disabled: cliBusy || !cliActive, onClick: cliExec }, t('run')),
        h('button', { className: 'mb-btn', disabled: cliBusy || !cliActive, onClick: cliShot }, t('screenshot')),
      ),
      h('pre', { className: 'mb-out', style: { maxHeight: '320px', marginTop: '10px' } },
        cliLog.length ? cliLog.join('\n') : t('noLog')),
    ));
    return h('div', { className: 'mb-root' }, children);
  }

  // 多设备：已连接设备列表（点 chip 切换活跃设备，● 为当前；断开在标题栏）
  if (STATE.sessions && STATE.sessions.length > 0) {
    const chips = STATE.sessions.map((sess) => {
      const isActive = sess.id === STATE.activeId;
      const model = (sess.info && sess.info.model) || (sess.device && sess.device.productName) || '';
      const serial = (sess.info && sess.info.serial) || (sess.device && (sess.device.serialNumber || sess.device.serial)) || '';
      const label = (model || serial || '设备') + (serial && model ? ' · ' + serial : '');
      const typeTag = sess.kind === 'hdc' ? '鸿蒙' : '安卓';
      return h('button', {
        key: 'dev-' + sess.id,
        className: 'mb-btn' + (isActive ? ' mb-btn--primary' : ''),
        style: { marginRight: '8px', marginBottom: '6px' },
        title: sess.id,
        onClick: () => {
          if (isActive) { return; }
          setActive(sess.id);
          setInfo(STATE.info || null);
          setPhase('connected');
          setError('');
        },
      }, (isActive ? '● ' : '') + typeTag + ' ' + label);
    });
    children.push(h('div', { key: 'devlist', className: 'mb-card' },
      h('div', {
        key: 'hdr',
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' },
      },
        h('div', { style: { fontWeight: 600 } }, t('devicesTitle') + '（' + STATE.sessions.length + '）'),
        h('button', { className: 'mb-btn', style: { padding: '4px 12px' }, onClick: disconnect }, t('disconnect')),
      ),
      h('div', {}, chips),
    ));
  }

  if (phase === 'reconnecting') {
    children.push(h('div', { key: 'rc', className: 'mb-note' }, t('reconnectingHint')));
  }

  if (!usbSupported) {
    children.push(h('div', { key: 'nu', className: 'mb-note' }, t('noWebusb')));
  }

  if (error) {
    children.push(h('div', { key: 'e', className: 'mb-err' }, error));
  }

  // 连接过程中实时显示日志与提示（直接从模块级 STATE.log 取，
  // 不依赖回调注册，避免组件重挂载导致回调为 null 而看不到任何提示）
  if (phase === 'connecting' && STATE.log && STATE.log.length) {
    const needConfirm = STATE.log.some((l) => l.indexOf('请在手机上点') >= 0);
    if (needConfirm) {
      children.push(h('div', {
        key: 'nc',
        className: 'mb-err',
        style: { marginTop: '6px' },
      }, '📱 请在手机上点「允许 / 始终信任」，然后保持本页面不要关闭'));
    }
    const tail = STATE.log.slice(-40).join('\n');
    children.push(h('pre', { key: 'live', className: 'mb-out' }, tail));
  }

  if (info) {
    children.push(h('div', { key: 'i', className: 'mb-card' },
      h('div', { className: 'mb-kv' },
        h('span', { className: 'mb-k' }, t('model')),
        h('span', { className: 'mb-v' }, info.model || '—'),
        h('span', { className: 'mb-k' }, t('sysVersion')),
        h('span', { className: 'mb-v' }, info.sysVersion || info.os || info.android || '—'),
        h('span', { className: 'mb-k' }, t('serial')),
        h('span', { className: 'mb-v' }, info.serial || '—'),
        h('span', { className: 'mb-k' }, t('usbId')),
        h('span', { className: 'mb-v' },
          '0x' + info.vendorId.toString(16) + ' / 0x' + info.productId.toString(16)),
      ),
    ));

    // ---- 本地安装（绕开 WebUSB，用本机 hdc.exe）---- 仅鸿蒙：包是 HAP
    if (info.kind === 'hdc') children.push(h('details', { key: 'locinstall', className: 'mb-card', style: { marginTop: '10px' } },
      h('summary', { style: { cursor: 'pointer', userSelect: 'none' } }, '本地安装（推荐：用电脑上的 hdc.exe）'),
      h('div', { className: 'mb-note', style: { marginTop: '6px', lineHeight: 1.7 } },
        '如果 WebUSB 一直报「设备被独占」，可以先验证 hdc 安装链路：下载下面的'
        + '示例包，用你电脑上 DevEco 自带的 hdc.exe 安装。hdc 自己占用设备，不经过浏览器。'),
      h('div', { className: 'mb-row', style: { marginTop: '8px' } },
        h('a', {
          className: 'mb-btn',
          href: '/mbridge/agc/hap',
          download: 'dsh_demo_signed.hap',
          style: { textDecoration: 'none', display: 'inline-block' },
        }, '下载示例包（9.9 MB）'),
      ),
      h('div', { className: 'mb-note', style: { marginTop: '10px' } }, '下载完成后，在 PowerShell 里运行这一条：'),
      h('pre', { className: 'mb-out', style: { whiteSpace: 'pre-wrap', userSelect: 'all' } },
        '& "C:\\Program Files\\Huawei\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe" install -r "$env:USERPROFILE\\Downloads\\dsh_demo_signed.hap"'),
      h('div', { className: 'mb-note', style: { marginTop: '6px' } },
        '说明：这是打包时固定生成的示例包，包名 com.dsh.bridgeapp，签名材料绑定的是开发机那台设备。'
        + '它只能用来验证 hdc 安装链路通不通，不能安装你自己的应用。'
        + '「针对任意应用自动申请证书 / Profile 并签名」的能力还没做完，别把它当成能用。'),
    ));

    children.push(h('div', { key: 'sh', className: 'mb-row' },
      h('input', {
        className: 'mb-input',
        value: cmd,
        spellCheck: false,
        onChange: (ev) => setCmd(ev.target.value),
        onKeyDown: (ev) => { if (ev.key === 'Enter' && !busy) { runShell(); } },
      }),
      h('button', { className: 'mb-btn', disabled: busy, onClick: runShell }, t('run')),
      h('button', { className: 'mb-btn', disabled: busy, onClick: screenshot }, t('screenshot')),
    ));

    // 设备日志：显示当前活跃设备的日志，默认「用户可读」，可勾选「完整日志」供开发者排查
    {
      const activeSess = STATE.sessions.find((x) => x.id === STATE.activeId);
      const logArr = STATE.log || [];
      const shown = showFullLog ? logArr : logArr.filter(isReadableLogLine);
      const sessName = activeSess
        ? ((activeSess.info && (activeSess.info.model || activeSess.info.serial)) || '设备')
        : '—';
      children.push(h('div', { key: 'devlog', className: 'mb-card', style: { marginTop: '10px' } },
        h('div', {
          key: 'h',
          style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' },
        },
          h('div', { style: { fontWeight: 600 } }, t('deviceLog') + '（' + sessName + '）'),
          h('label', { style: { fontSize: '12px', cursor: 'pointer', userSelect: 'none' } },
            h('input', {
              type: 'checkbox', checked: showFullLog,
              onChange: (e) => setShowFullLog(e.target.checked),
              style: { marginRight: '5px', verticalAlign: 'middle' },
            }),
            t('fullLog'),
          ),
        ),
        h('pre', { className: 'mb-out', style: { maxHeight: '240px' } },
          shown.length ? shown.join('\n') : t('noLog')),
      ));
    }
  }

  const diagText =
    '桥接 ' + DIAG.state +
    ' · connection=' + (DIAG.injected || '—') +
    ' · 轮询 ' + DIAG.polls + ' 次' +
    (DIAG.lastOk ? ' · 最近成功 ' + Math.max(0, Math.round((Date.now() - DIAG.lastOk) / 1000)) + 's 前' : '') +
    (DIAG.error ? ' · 错误: ' + DIAG.error : '');
  children.push(h('div', { key: 'diag', className: 'mb-note', style: { fontSize: '11.5px' } }, diagText));

  children.push(h('div', { key: 'n', className: 'mb-note' }, t(STATE.kind === 'hdc' ? 'hintHdc' : 'hintAdb')));

  return h('div', { className: 'mb-root' }, children);
}

function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, {
    zh: {
      nav: '移动设备',
      connect: '连接设备',
      connecting: '连接中…',
      disconnect: '断开',
      run: '执行',
      screenshot: '截图',
      copy: '复制输出',
      copied: '已复制',
      copyFailed: '复制失败：浏览器拒绝了剪贴板写入，请手动选中输出复制。',
      os: '系统',
      diagnose: '诊断',
      hintAdb: '连接会跟着页面保留：关掉设置、切到别页再回来都不用重连；刷新页面则会断开，之后会自动尝试恢复。需要在手机上开启「USB 调试」，首次连接时手机会弹出授权提示。同一时刻只能有一个程序占用 USB，请先停掉本机的 adb server、Android Studio、scrcpy 等。',
      hintHdc: '连接会跟着页面保留：关掉设置、切到别页再回来都不用重连；刷新页面则会断开。需要在手机上开启「USB 调试」，并且本机不能有 hdc / DevEco Studio 正在占用设备（连接前先执行 hdc kill）。首次连接需要在手机上点「允许 / 始终信任」；之后同一把密钥不会再询问。连接建立后才可用命令与截图。',
      navAccount: '华为账号',
      devicesTitle: '已连接设备',
      sysVersion: '系统版本',
      deviceLog: '设备日志',
      fullLog: '完整日志（开发者）',
      chWeb: '浏览器',
      chCli: '本机命令行',
      cliRefresh: '刷新本机设备',
      cliNotFound: '未找到 adb/hdc（装 DevEco / Platform-Tools，或确认在 PATH）',
      cliNoDev: '（没有可用设备：插好手机、开启 USB 调试，确认命令行能看到）',
      cliHint: '点「刷新本机设备」自动探测 adb/hdc',
      noLog: '（暂无日志）',
      accountTitle: '华为账号登录',
      accountHintShort: '登录态保存在本机，插件重载、切页、重连手机都不需要重新登录。',
      accountHint: '用手机「控制中心 → 扫一扫」扫码登录华为开发者账号，登录态只保存在本机。当前版本只做到「登录 + 保存凭证」；自动申请调试证书 / Profile 还没做完，不能替你给任意应用签名。',
      accountStatusOk: '已登录',
      accountStatusNone: '未登录',
      accountRelogin: '重新登录',
      accountPersistTitle: '登录态如何保存',
      accountPersistHint: '登录态保存在本机（~/.dsh/agc-session.json，权限 600），不会上传到任何地方。\n插件重载、切换页面、重连手机都不需要重新登录；只有你点「退出登录」或华为侧会话失效时才需要再扫一次。',
      agcTitle: '华为账号登录（管理登录态）',
      agcHint: '用手机「控制中心 → 扫一扫」扫码登录华为开发者账号，登录态只保存在本机、不上传。自动申请调试证书与 Profile 的功能仍在开发中，当前版本还不能替你签名任意应用。',
      agcLogin: '开始登录（显示二维码）',
      agcRefresh: '刷新二维码',
      agcLogout: '退出登录（清除本机凭证）',
      agcWaiting: '等待扫码…二维码约 2 分钟有效',
      agcSuccess: '已登录，登录态已保存',
      agcFailed: '登录失败',
      agcNoQr: '点「开始登录」后在手机扫码',
      agcPwdTitle: '账号密码登录',
      agcAccount: '华为账号（手机号/邮箱）',
      agcPassword: '密码',
      agcPwdSubmit: '登录',
      agcCodeTitle: '短信验证码',
      agcCodeSubmit: '提交验证码',
      agcPwdHint: '账号密码只在本机转发给登录进程，不写日志、不保存。若弹出滑块验证，直接在下面的画面上拖动即可。',
      agcManual: '手动完成验证（在画面上拖动滑块 / 点击）',
      agcExtTitle: '方式一：用你本机的浏览器登录（推荐）',
      agcExtHint: '1) 点下面下载扩展 → 解压；2) 浏览器打开 chrome://extensions 或 edge://extensions，开启「开发者模式」，选择「加载已解压的扩展程序」，选中解压出来的文件夹；3) 在浏览器里正常登录 developer.huawei.com（密码/短信/扫码都行）；4) 点浏览器工具栏里的扩展图标 →「发送登录态给 DSH」。',
      agcExtDownload: '下载扩展（zip）',
      agcCheck: '检查登录态',
      agcManualBtn: '打开浏览器画面',
      agcViewHint: '画面来自宿主的浏览器。拖动滑块：在图上按住并往右拖；也可以直接点击。',
      hdcKeyTitle: '密钥设置（默认已自动保存，无需操作）',
      hdcKeyReset: '重置密钥',
      hdcKeyStored: '默认会保存一把密钥并复用，授权只需做一次；只有想换密钥时才需要点重置',
      hdcKeyHint: '如果你的电脑上 hdc 已经能连上这台手机，说明它的密钥已被设备信任。把这两个文件的内容一起粘贴进来（先私钥再公钥）：\nC:\\Users\\<你>\\.harmony\\hdckey  和  hdckey.pub\n提取方法（PowerShell）：Get-Content -Raw "$env:USERPROFILE\\.harmony\\hdckey"; Get-Content -Raw "$env:USERPROFILE\\.harmony\\hdckey.pub"',
      kindLabel: '设备类型',
      kindAdb: 'Android',
      kindHdc: 'HarmonyOS',
      hdcHint: 'HarmonyOS 走 HDC 协议（WebUSB 直连），首次连接会在设备上弹出授权，全部完成后才会显示「已连接」。',
      model: '机型',
      android: 'Android',
      serial: '序列号',
      usbId: 'USB ID',
      stateConnected: '已连接',
      stateIdle: '未连接',
      stateReconnecting: '正在恢复连接…',
      reconnectingHint: '检测到之前授权过的设备，正在用已保存的 RSA 密钥自动重连，不需要再点按钮。',
      noWebusb: '当前浏览器不支持 WebUSB。请使用 Chrome 或 Edge 打开本页面。',
      errBusy: '手机已被另一个程序占用（这一步是浏览器拿到了 USB 设备，但接口被抢占）。\n请在你自己电脑上依次做：\n1) 关掉 adb 服务：adb kill-server（Windows 任务管理器里结束 adb.exe）\n2) 退出 Android Studio、scrcpy、华为 HiSuite、各类手机助手\n3) 拔掉数据线再插回去，保持屏幕解锁\n4) 回到这里重新点「连接设备」',
      errExclusive: '设备在 open 阶段被拒绝（Access denied），说明有程序正独占它。注意：错误发生在 open 而不是 claim，通常**不是驱动问题**，而是有进程/页面握着这个设备。\n\n按可能性从高到低排查：\n\n【最常见】Chrome 自己还占着（上一次连接没释放，比如大文件传输超时后）\n  → 完全退出 Chrome（关掉所有窗口；任务管理器确认 chrome.exe 全部结束），再重新打开本页面\n\n【其次】DevEco Studio（内置 hdc，会不停重启 server）\n  → 完全退出 DevEco Studio（不是关窗口，是在任务管理器结束 devecostudio64.exe / idea64.exe / hdc.exe）\n\n【兜底】物理重置\n  → 拔掉 USB 线，等 3 秒再插回去，保持手机解锁\n\n查占用（Windows PowerShell）：\n  Get-Process chrome,devecostudio64,idea64,hdc,hdc_std,HiSuite -ErrorAction SilentlyContinue | Select Name,Id\n\n做完【不要运行任何 hdc 命令】，立刻点「连接设备」。',
      errHdcBusy: '浏览器无法接管 HDC 接口——几乎总是因为这台电脑上的 hdc server 正占着它（DevEco Studio 会自动拉起 hdc）。\n请在该电脑上依次做：\n1) 执行 hdc kill（或在任务管理器里结束 hdc.exe）\n2) 关闭 DevEco Studio / 手机助手 / HiSuite\n3) 拔掉数据线再插回去，保持屏幕解锁\n4) 回到这里重新点「连接设备」\n若 hdc kill 后仍失败，才是驱动问题（该 HDC 接口未绑定 WinUSB）。',
      errDriver: '浏览器无法接管该 USB 接口，通常是手机在 Windows 上绑的是 MTP/厂商驱动而不是 WinUSB。\n请在电脑上安装 Google Android USB Driver，或在设备管理器里把该设备的驱动改为 WinUSB，然后重新插拔。',
      errGesture: '浏览器要求由点击触发设备选择，请直接点「连接设备」按钮，不要通过脚本调用。',
      hint: '连接会跟着页面保留：关掉设置、切到别的页再回来都不用重连；刷新页面则会断开，之后会自动尝试恢复。需要在手机上开启「USB 调试」，首次连接时手机会弹出授权提示。同一时刻只能有一个程序占用 USB，请先停掉本机的 adb server、Android Studio、scrcpy 等。',
    },
    en: {
      nav: 'Mobile device',
      connect: 'Connect device',
      connecting: 'Connecting…',
      disconnect: 'Disconnect',
      run: 'Run',
      screenshot: 'Screenshot',
      copy: 'Copy output',
      copied: 'Copied',
      copyFailed: 'Copy failed: the browser refused clipboard access. Select the output and copy manually.',
      os: 'OS',
      diagnose: 'Diagnose',
      hintAdb: 'The connection survives closing settings or switching pages; reloading the page drops it and it will try to reconnect. Enable USB debugging on the phone and confirm the authorization prompt on first connect. Only one program may hold the USB device, so stop the adb server, Android Studio and scrcpy first.',
      hintHdc: 'The connection survives closing settings or switching pages; reloading drops it. Enable USB debugging on the phone and make sure no hdc / DevEco Studio is holding the device (run hdc kill first). On first connect tap Allow / Always trust on the phone; the saved key is not asked for again. Commands and screenshots work once connected.',
      navAccount: 'Huawei account',
      devicesTitle: 'Connected devices',
      sysVersion: 'OS version',
      deviceLog: 'Device log',
      fullLog: 'Full log (developer)',
      chWeb: 'Browser',
      chCli: 'Local CLI',
      cliRefresh: 'Refresh local devices',
      cliNotFound: 'adb/hdc not found (install DevEco / Platform-Tools or ensure on PATH)',
      cliNoDev: '(no device: plug in phone, enable USB debugging, ensure the CLI sees it)',
      cliHint: 'Click "Refresh local devices" to detect adb/hdc',
      noLog: '(no log yet)',
      accountTitle: 'Huawei account sign-in',
      accountHintShort: 'The session is stored on this machine; reloading, switching pages or reconnecting the phone needs no new sign-in.',
      accountHint: 'Scan the QR with your phone (Control Center > Scan) to sign in. Once signed in, the plugin requests a debug certificate, mints a debug profile and signs HAPs for you - no signing material needed on your side.',
      accountStatusOk: 'Signed in',
      accountStatusNone: 'Not signed in',
      accountRelogin: 'Sign in again',
      accountPersistTitle: 'How the session is kept',
      accountPersistHint: 'The session is stored on this machine (~/.dsh/agc-session.json, mode 600) and is never uploaded.\nReloading the plugin, switching pages or reconnecting the phone does not require another sign-in; only signing out or an expiry on the Huawei side does.',
      agcTitle: 'Huawei account sign-in (for automatic signing)',
      agcHint: 'Scan the QR with your phone (Control Center > Scan) to sign in. The session stays on this machine and is used to request a debug certificate and profile; you do not need to supply a pre-signed HAP.',
      agcLogin: 'Start sign-in (show QR)',
      agcRefresh: 'Refresh QR',
      agcLogout: 'Log out (clear local credential)',
      agcWaiting: 'Waiting for the scan - the QR expires after about two minutes',
      agcSuccess: 'Signed in, session saved',
      agcFailed: 'Sign-in failed',
      agcNoQr: 'Click Start sign-in, then scan with your phone',
      hdcKeyTitle: 'Key settings (a key is generated and saved automatically)',
      hdcKeyReset: 'Reset key',
      hdcKeyStored: 'The generated key is kept and reused, so authorization is needed once. Reset only if you want a new key.',
      hdcKeyHint: 'If hdc already connects to this phone from this PC, that key is trusted. Paste both files (private key first, then public key).',
      kindLabel: 'Device type',
      kindAdb: 'Android',
      kindHdc: 'HarmonyOS',
      hdcHint: 'HarmonyOS uses the HDC protocol over WebUSB. The device asks for authorization on first connect; the panel shows Connected only after it completes.',
      model: 'Model',
      android: 'Android',
      serial: 'Serial',
      usbId: 'USB ID',
      stateConnected: 'Connected',
      stateIdle: 'Not connected',
      stateReconnecting: 'Restoring connection…',
      reconnectingHint: 'A previously authorized device was found; reconnecting with the stored RSA key, no click needed.',
      noWebusb: 'This browser has no WebUSB support. Open this page in Chrome or Edge.',
      errBusy: 'The phone is held by another program: the browser reached the USB device but could not claim the interface.\nOn your own computer:\n1) stop the adb server: adb kill-server (or end adb.exe in Task Manager)\n2) quit Android Studio, scrcpy, HiSuite and phone-assistant tools\n3) unplug and replug the cable, keep the screen unlocked\n4) click "Connect device" again',
      errExclusive: 'The device was refused at open (Access denied), so some program holds it exclusively. The failure is at open rather than claim, which usually means a process or page still owns it, not a driver problem.\n\nCheck in this order:\n\n[most likely] Chrome itself still holds it (a previous connection was never released, e.g. after a large transfer timed out)\n  -> Quit Chrome completely (close every window; confirm no chrome.exe remains in Task Manager), then reopen this page\n\n[next] DevEco Studio (bundles hdc and keeps restarting the server)\n  -> Quit it fully (end devecostudio64.exe / idea64.exe / hdc.exe in Task Manager, not just close the window)\n\n[last resort] Physical reset\n  -> Unplug the USB cable, wait 3 seconds, plug it back in, keep the phone unlocked\n\nFind the holder (Windows PowerShell):\n  Get-Process chrome,devecostudio64,idea64,hdc,hdc_std,HiSuite -ErrorAction SilentlyContinue | Select Name,Id\n\nAfter that do NOT run any hdc command; click "Connect device" immediately.',
      errHdcBusy: 'The browser cannot claim the HDC interface. This is almost always because the hdc server on this computer is holding it (DevEco Studio starts hdc automatically).\nOn that computer:\n1) run hdc kill (or end hdc.exe in Task Manager)\n2) quit DevEco Studio / HiSuite / phone-assistant tools\n3) unplug and replug the cable, keep the screen unlocked\n4) click "Connect device" again\nIf it still fails after hdc kill, then it is a driver problem (HDC interface not bound to WinUSB).',
      errDriver: 'The browser cannot take over this USB interface. On Windows the phone is usually bound to the MTP/vendor driver instead of WinUSB.\nInstall the Google Android USB Driver, or switch the device driver to WinUSB in Device Manager, then replug.',
      errGesture: 'The browser requires a click to open the device chooser. Press the "Connect device" button directly.',
      hint: 'The connection survives closing settings or switching tabs; a page refresh drops it and triggers an automatic restore attempt. Enable USB debugging on the phone; the first connection asks for authorization on the device. Only one program can hold the USB interface, so stop the local adb server, Android Studio, and scrcpy first.',
    },
  }), 'mobile-bridge: locale');

  const t = ctx.locale.bind(NS);

  // 与宿主建立任务通道（不依赖 UI 是否挂载）
  // 不依赖 dsh.client.inject 的加载顺序：connection 服务可能在我之后才 provide，
  // 所以轮询等待它出现再启动桥（apply 期间拿不到就每 800ms 再试）。
  ctx.effect(() => {
    let cancelled = false;
    let timer = null;
    let stopBridge = null;

    const attempt = () => {
      if (cancelled || stopBridge) { return; }
      let conn = null;
      try { conn = ctx.get('connection'); } catch (e) {
        DIAG.injected = 'throw: ' + String(e && e.message ? e.message : e);
        DIAG.state = 'no-connection';
        timer = setTimeout(attempt, 800);
        return;
      }
      if (conn && conn.rpc && typeof conn.rpc.call === 'function') {
        DIAG.injected = 'ok';
        stopBridge = startBridge(conn);
        return;
      }
      DIAG.injected = conn ? 'no-rpc' : 'waiting';
      DIAG.state = 'waiting-connection';
      timer = setTimeout(attempt, 800);
    };

    attempt();
    return () => {
      cancelled = true;
      if (timer) { clearTimeout(timer); }
      if (stopBridge) { stopBridge(); }
    };
  }, 'mobile-bridge: host bridge');

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'mobile-bridge',
    order: 32,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ t }),
  }, MobileBridgeSection));
}

exports.apply = apply;
exports.friendly = friendly;
exports.inject = inject;
exports.isReadableLogLine = isReadableLogLine;

return module.exports; } });
