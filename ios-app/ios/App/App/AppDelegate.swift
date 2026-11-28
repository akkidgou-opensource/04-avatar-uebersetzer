import UIKit
import Capacitor
import AVFoundation

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // mitano.: Audio-Sitzung wie bei einem Videoanruf über den Lautsprecher (Echo-Unterdrückung für Lautsprecher abgestimmt).
        MitanoAudio.einrichten()
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        MitanoAudio.anwenden()
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}


/// mitano.: Knacken über den Lautsprecher in der App (Safari war sauber, mit Kopfhörern sauber).
/// Die App gibt dem iPhone jetzt ausdrücklich den Modus „Videoanruf über Lautsprecher“ vor
/// (playAndRecord + .videoChat + defaultToSpeaker). Stellt WebKit beim Mikro-Start auf einen anderen Modus um,
/// wird der Modus höchstens alle 2 s wieder gesetzt (keine Endlosschleife).
enum MitanoAudio {
    private static var beobachter: NSObjectProtocol?
    private static var zuletzt = Date.distantPast

    static func einrichten() {
        anwenden()
        beobachter = NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { _ in
            let s = AVAudioSession.sharedInstance()
            if s.category == .playAndRecord && s.mode != .videoChat && Date().timeIntervalSince(zuletzt) > 2 {
                anwenden()
            }
        }
    }

    static func anwenden() {
        zuletzt = Date()
        let s = AVAudioSession.sharedInstance()
        do {
            if s.category != .playAndRecord || s.mode != .videoChat || !s.categoryOptions.contains(.defaultToSpeaker) {
                try s.setCategory(.playAndRecord, mode: .videoChat, options: [.defaultToSpeaker, .allowBluetoothA2DP])
            }
            try s.setActive(true)
        } catch {
            NSLog("mitano. Audio-Sitzung: %@", String(describing: error))
        }
    }
}
