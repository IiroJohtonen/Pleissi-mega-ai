import { embeddingSuite } from "./embedding-suite.js";

// Merkityshaku ilman sqlite-vec:iä: vektoreita verrataan muistissa.
embeddingSuite("Merkityshaku (muistivertailu)", { EMBEDDING_SQLITE_VEC: "false" });
