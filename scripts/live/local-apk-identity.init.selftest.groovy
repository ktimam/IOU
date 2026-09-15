// Execute the actual init script with Gradle lifecycle fixtures. No Gradle build or key is loaded.
import groovy.json.JsonSlurper

class GradleException extends RuntimeException {
    GradleException(String message) { super(message) }
}
class LifecycleFixture {
    Closure settingsHook
    Closure projectHook
    void settingsEvaluated(Closure action) { settingsHook = action }
    void beforeProject(Closure action) { projectHook = action }
}

assert args.length == 1 : 'Supply the actual init-script path'
def profile = new JsonSlurper().parse(new File(System.getenv('OC_LOCAL_APK_IDENTITY_PROFILE')))
def root = new File(profile.androidRoot).canonicalFile
def lifecycle = new LifecycleFixture()
def shell = new GroovyShell(this.class.classLoader, new Binding([gradle: lifecycle]))
shell.evaluate(new File(args[0]))
assert lifecycle.settingsHook != null && lifecycle.projectHook != null
int checks = 1
def reject = { Closure action, String fragment ->
    boolean rejected = false
    try { action() } catch (GradleException failure) {
        assert failure.message.contains(fragment)
        rejected = true
    }
    assert rejected : "Expected rejection: ${fragment}"
    checks++
}
lifecycle.settingsHook([settingsDir: root]); checks++
lifecycle.settingsHook([settingsDir: new File(root, 'buildSrc')]); checks++
lifecycle.settingsHook([settingsDir: new File(root, 'included/helper')]); checks++
reject({ lifecycle.settingsHook([settingsDir: root.parentFile]) }, 'different project')
reject({ lifecycle.settingsHook([settingsDir: new File(root.parentFile, root.name + '-other')]) }, 'different project')

int pluginRegistrations = 0
Closure finalizeHook
def project = { File projectRoot, String path ->
    [rootDir: projectRoot, path: path,
     pluginManager: [withPlugin: { String id, Closure configure ->
         assert id == 'com.android.application'
         pluginRegistrations++
         configure()
     }],
     extensions: [getByName: { String name ->
         assert name == 'androidComponents'
         [finalizeDsl: { Closure configure -> finalizeHook = configure }]
     }]]
}
lifecycle.projectHook(project(new File(root, 'buildSrc'), ':app'))
lifecycle.projectHook(project(new File(root, 'included/helper'), ':app'))
lifecycle.projectHook(project(root, ':sample'))
assert pluginRegistrations == 0 && finalizeHook == null; checks++
lifecycle.projectHook(project(root, ':app'))
assert pluginRegistrations == 1 && finalizeHook != null; checks++
// These fail before the signing-certificate step; the fake key is never read.
reject({ finalizeHook([namespace: 'wrong.namespace', defaultConfig: [applicationId: profile.namespace]]) }, 'namespace/applicationId changed')
reject({ finalizeHook([namespace: profile.namespace, defaultConfig: [applicationId: 'wrong.installed.id']]) }, 'namespace/applicationId changed')
println "Local APK init lifecycle fixture: ${checks} checks passed; no AGP build or key reads"
