"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const FILE_TYPES = new Map([
    [".pdf", "application/pdf"],
    [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    [".txt", "text/plain"]
]);

class FileStoreError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

class FileStore {
    constructor({ root, maxFileBytes, r2 }) {
        this.root = root;
        this.maxFileBytes = maxFileBytes;
        this.r2 = r2;
        this.client = r2 ? new S3Client({
            region: "auto",
            endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
            credentials: {
                accessKeyId: r2.accessKeyId,
                secretAccessKey: r2.secretAccessKey
            }
        }) : null;
    }

    get usesRemoteStorage() {
        return Boolean(this.client);
    }

    async prepareUpload(userId, originalName, declaredSize) {
        const filename = path.win32.basename(originalName);
        const extension = path.extname(filename).toLocaleLowerCase();
        const contentType = FILE_TYPES.get(extension);
        if (!contentType) throw new FileStoreError(400, "Choose a PDF, DOCX, or TXT document.");
        if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0 || declaredSize > this.maxFileBytes) {
            throw new FileStoreError(400, "Files must be larger than zero bytes and 10 MB or smaller.");
        }

        const key = `papers/${Number(userId)}/${crypto.randomUUID()}${extension}`;
        const url = await getSignedUrl(this.client, new PutObjectCommand({
            Bucket: this.r2.bucket,
            Key: key,
            ContentType: contentType
        }), { expiresIn: 300 });
        return { key, url, contentType, fileName: filename.slice(0, 255) };
    }

    async verifyUpload(key, userId) {
        const prefix = `papers/${Number(userId)}/`;
        if (typeof key !== "string" || !key.startsWith(prefix) || key.includes("..") || key.includes("\\")) {
            throw new FileStoreError(400, "The uploaded document is not valid for this account.");
        }
        const extension = path.extname(key).toLocaleLowerCase();
        const contentType = FILE_TYPES.get(extension);
        if (!contentType) throw new FileStoreError(400, "Choose a PDF, DOCX, or TXT document.");

        let metadata;
        try {
            metadata = await this.client.send(new HeadObjectCommand({
                Bucket: this.r2.bucket,
                Key: key
            }));
        } catch (error) {
            if (error.name === "NotFound" || error.$metadata && error.$metadata.httpStatusCode === 404) {
                throw new FileStoreError(400, "The uploaded document could not be found. Please upload it again.");
            }
            throw error;
        }
        if (!Number.isSafeInteger(metadata.ContentLength) ||
            metadata.ContentLength <= 0 || metadata.ContentLength > this.maxFileBytes) {
            await this.delete(key);
            throw new FileStoreError(400, "Files must be larger than zero bytes and 10 MB or smaller.");
        }

        const result = await this.client.send(new GetObjectCommand({
            Bucket: this.r2.bucket,
            Key: key,
            Range: "bytes=0-7"
        }));
        const header = Buffer.from(await result.Body.transformToByteArray());
        if (extension === ".pdf" && header.subarray(0, Math.min(header.length, 5)).toString("ascii") !== "%PDF-") {
            await this.delete(key);
            throw new FileStoreError(400, "This file does not appear to be a valid PDF.");
        }
        if (extension === ".docx" &&
            !(header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04)) {
            await this.delete(key);
            throw new FileStoreError(400, "This file does not appear to be a valid DOCX document.");
        }
        if (extension === ".txt" && header.includes(0)) {
            await this.delete(key);
            throw new FileStoreError(400, "Text files must contain plain text.");
        }

        return { size: metadata.ContentLength, contentType, extension };
    }

    async download(key, filename, response, next) {
        let result;
        try {
            result = await this.client.send(new GetObjectCommand({
                Bucket: this.r2.bucket,
                Key: key
            }));
        } catch (error) {
            if (error.name === "NoSuchKey" || error.$metadata && error.$metadata.httpStatusCode === 404) {
                next(new FileStoreError(404, "The stored document could not be found."));
                return;
            }
            next(error);
            return;
        }

        response.setHeader("Content-Type", "application/octet-stream");
        if (Number.isSafeInteger(result.ContentLength)) response.setHeader("Content-Length", result.ContentLength);
        response.attachment(filename);
        try {
            await pipeline(result.Body, response);
        } catch (error) {
            if (response.headersSent) response.destroy(error);
            else next(error);
        }
    }

    async delete(key) {
        if (!key) return;
        await this.client.send(new DeleteObjectCommand({
            Bucket: this.r2.bucket,
            Key: key
        }));
    }
}

function createFileStore(options) {
    return new FileStore(options);
}

module.exports = { createFileStore, FILE_TYPES, FileStoreError };
