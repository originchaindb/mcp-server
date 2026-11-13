import { createHash, randomBytes } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { KMSClient, EncryptCommand, DecryptCommand } from "@aws-sdk/client-kms";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const kms = new KMSClient({});
export const now = () => Math.floor(Date.now() / 1000);
export const nonce = () => randomBytes(32).toString("base64url");
export const digest = value => createHash("sha256").update(value).digest("base64url");
const key = (type, value) => type + "#" + digest(value);

export class GrantStore {
  constructor(table, keyId) {
    this.table = table;
    this.keyId = keyId;
  }
  item(type, id, data, expires) {
    return { pk: key(type, id), data, expires };
  }
  async put(type, id, data, expires) {
    await db.send(new PutCommand({ TableName: this.table, Item: this.item(type, id, data, expires),
      ConditionExpression: "attribute_not_exists(pk)" }));
  }
  async get(type, id) {
    if (typeof id !== "string" || !id || id.length > 512) return;
    const { Item } = await db.send(new GetCommand({ TableName: this.table, Key: { pk: key(type, id) }, ConsistentRead: true }));
    if (Item && (!Item.expires || Item.expires > now())) return Item.data;
  }
  async exchange(type, id, records) {
    const actions = [{ Delete: { TableName: this.table, Key: { pk: key(type, id) },
      ConditionExpression: "attribute_exists(pk) AND expires > :now", ExpressionAttributeValues: { ":now": now() } } }];
    for (const item of records) actions.push({ Put: { TableName: this.table, Item: item, ConditionExpression: "attribute_not_exists(pk)" } });
    try { await db.send(new TransactWriteCommand({ TransactItems: actions })); return true; }
    catch (err) {
      if (err.name === "TransactionCanceledException" && err.CancellationReasons?.some(x => x.Code === "ConditionalCheckFailed")) return false;
      throw err;
    }
  }
  async revokeGrant(id) {
    await db.send(new DeleteCommand({ TableName: this.table, Key: { pk: key("grant", id) } }));
  }
  async seal(grant, data) {
    const { CiphertextBlob } = await kms.send(new EncryptCommand({ KeyId: this.keyId, Plaintext: Buffer.from(JSON.stringify(data)),
      EncryptionContext: { service: "originchaindb-mcp", grant } }));
    return Buffer.from(CiphertextBlob).toString("base64");
  }
  async unseal(grant, ciphertext) {
    const { Plaintext } = await kms.send(new DecryptCommand({ KeyId: this.keyId, CiphertextBlob: Buffer.from(ciphertext, "base64"),
      EncryptionContext: { service: "originchaindb-mcp", grant } }));
    return JSON.parse(Buffer.from(Plaintext).toString("utf8"));
  }
}
