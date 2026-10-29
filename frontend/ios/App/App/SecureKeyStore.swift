import Foundation
import Security

/// The offline mesh's storage key (docs/10 C7): the iOS twin of SecureKeyStore.java. A random
/// 32-byte key kept in the Keychain (this device only, after first unlock), which the web side
/// uses to seal the keys it keeps in IndexedDB and localStorage. Deleting it (panic wipe) makes
/// everything sealed with it unreadable at once.
enum SecureKeyStore {
    private static let service = "com.demodiscord.app.mesh"
    private static let account = "storage-key"

    private static var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    /// Returns the storage key, making one the first time.
    static func getOrCreate() throws -> Data {
        var read = query
        read[kSecReturnData as String] = true
        read[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(read as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data, data.count == 32 {
            return data
        }
        if status != errSecItemNotFound && status != errSecSuccess {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }

        var key = Data(count: 32)
        let random = key.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        if random != errSecSuccess { throw NSError(domain: NSOSStatusErrorDomain, code: Int(random)) }

        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = key
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let added = SecItemAdd(add as CFDictionary, nil)
        if added != errSecSuccess { throw NSError(domain: NSOSStatusErrorDomain, code: Int(added)) }
        return key
    }

    /// Forgets the storage key (panic wipe).
    static func delete() {
        SecItemDelete(query as CFDictionary)
    }
}
