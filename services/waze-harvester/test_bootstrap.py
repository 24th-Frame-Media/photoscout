import subprocess
import unittest
from unittest.mock import patch
from boot_emulator import AVD_NAME, prepare_debug_transport, prepare_software_guest, prepare_integrity_verification, wait_android_services, start_report_reader, quiet_software_guest, compile_waze, emulator_acceleration

class DebugTransportTests(unittest.TestCase):
    def test_root_restart_timeout_is_recovered_and_actual_root_is_verified(self):
        timeout = subprocess.CalledProcessError(1, ['adb', 'root'], stderr='timeout expired while waiting for device')
        with patch('boot_emulator.run', side_effect=[timeout, subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 0, stdout='0\n')]) as run:
            prepare_debug_transport()
            self.assertEqual(run.call_args_list[-1].args[-2:], ('id', '-u'))

    def test_non_root_images_are_rejected(self):
        with patch('boot_emulator.run', side_effect=[subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 0, stdout='2000\n')]):
            with self.assertRaisesRegex(RuntimeError, 'support adb root'):
                prepare_debug_transport()

    def test_unrelated_root_errors_are_not_hidden(self):
        error = subprocess.CalledProcessError(1, ['adb', 'root'], stderr='adbd cannot run as root in production builds')
        with patch('boot_emulator.run', side_effect=error):
            with self.assertRaises(subprocess.CalledProcessError): prepare_debug_transport()


class AndroidReadinessTests(unittest.TestCase):
    def test_boot_flag_does_not_replace_package_manager_readiness(self):
        results = [subprocess.CompletedProcess([], 0, stdout='0\tactivity: [android.app.IActivityManager]\n'),
                   subprocess.CompletedProcess([], 0, stdout='0\tactivity: [android.app.IActivityManager]\n1\tpackage: [android.content.pm.IPackageManager]\n')]
        with patch('boot_emulator.run', side_effect=results) as run, patch('boot_emulator.STOP.wait'):
            wait_android_services()
            self.assertEqual(run.call_count, 2)

    def test_readiness_deadline_reports_failure(self):
        with self.assertRaisesRegex(RuntimeError, 'services are not ready'):
            wait_android_services(timeout=0)


class SoftwareGuestTests(unittest.TestCase):
    def test_another_emulator_is_rejected_before_root_or_framework_changes(self):
        results = [subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 0, stdout='some-other-device\nOK\n')]
        with patch('boot_emulator.run', side_effect=results) as run, patch('boot_emulator.prepare_debug_transport') as root:
            with self.assertRaisesRegex(RuntimeError, 'must own'):
                prepare_software_guest()
            root.assert_not_called()
            self.assertEqual(run.call_count, 2)

    def test_a_prepared_guest_does_not_restart_its_framework(self):
        results = [subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 0, stdout=f'{AVD_NAME}\nOK\n'),
                   subprocess.CompletedProcess([], 0, stdout='10\n')]
        with patch('boot_emulator.run', side_effect=results) as run, patch('boot_emulator.prepare_debug_transport'):
            prepare_software_guest()
            self.assertFalse(any(call.args[-1] in ('stop', 'start', 'setprop') for call in run.call_args_list))

    def test_failed_property_update_always_restarts_the_owned_framework(self):
        failure = subprocess.CalledProcessError(1, ['adb', 'shell', 'setprop'])
        results = [subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 0, stdout=f'{AVD_NAME}\nOK\n'),
                   subprocess.CompletedProcess([], 0, stdout=''), subprocess.CompletedProcess([], 0), failure,
                   subprocess.CompletedProcess([], 0)]
        with patch('boot_emulator.run', side_effect=results) as run, patch('boot_emulator.prepare_debug_transport'):
            with self.assertRaises(subprocess.CalledProcessError):
                prepare_software_guest()
            self.assertEqual(run.call_args.args[-1], 'start')

class IntegrityTimeoutTests(unittest.TestCase):
    def result(self, value=''):
        return subprocess.CompletedProcess([], 0, stdout=value)

    def test_another_guest_cannot_have_its_settings_changed(self):
        with patch('boot_emulator.run', return_value=self.result('another-avd\nOK\n')) as run:
            with self.assertRaisesRegex(RuntimeError, 'Only the owned'):
                prepare_integrity_verification()
            self.assertEqual(run.call_count, 1)

    def test_slow_guest_gets_more_verification_time_without_disabling_checks(self):
        results = [self.result(f'{AVD_NAME}\nOK\n'), self.result('null\n'), self.result(), self.result('600000\n')]
        with patch('boot_emulator.run', side_effect=results) as run:
            prepare_integrity_verification()
            mutations = [call.args for call in run.call_args_list if 'put' in call.args]
            self.assertEqual(len(mutations), 1)
            self.assertEqual(mutations[0][-4:], ('put', 'global', 'app_integrity_verification_timeout', '600000'))

    def test_an_existing_longer_timeout_is_preserved(self):
        with patch('boot_emulator.run', side_effect=[self.result(f'{AVD_NAME}\nOK\n'), self.result('1200000\n')]) as run:
            prepare_integrity_verification()
            self.assertEqual(run.call_count, 2)

    def test_a_failed_setting_readback_stops_installation(self):
        results = [self.result(f'{AVD_NAME}\nOK\n'), self.result('null\n'), self.result(), self.result('30000\n')]
        with patch('boot_emulator.run', side_effect=results):
            with self.assertRaisesRegex(RuntimeError, 'was not applied'):
                prepare_integrity_verification()


class ReportReaderStartupTests(unittest.TestCase):
    def test_a_running_daemon_is_reused_without_another_transfer(self):
        with patch('boot_emulator.run', return_value=subprocess.CompletedProcess([], 0, stdout='7448\n')) as run:
            start_report_reader()
            self.assertEqual(run.call_count, 1)

    def test_a_timed_out_start_is_recovered_only_when_daemon_exists(self):
        absent = subprocess.CalledProcessError(1, ['pidof'])
        started = subprocess.CompletedProcess([], 0, stdout='7448\n')
        timeout = subprocess.TimeoutExpired(['frida-server'], 300)
        with patch('boot_emulator.Path.exists', return_value=True), patch('boot_emulator.run', side_effect=[absent, started, started, timeout, started]):
            start_report_reader()

    def test_a_failed_start_is_not_reported_as_ready(self):
        absent = subprocess.CompletedProcess([], 0, stdout='')
        timeout = subprocess.TimeoutExpired(['frida-server'], 300)
        with patch('boot_emulator.Path.exists', return_value=True), patch('boot_emulator.run', side_effect=[absent, absent, absent, timeout, absent]):
            with self.assertRaises(subprocess.TimeoutExpired):
                start_report_reader()

    def test_transport_errors_do_not_trigger_a_new_daemon(self):
        with patch('boot_emulator.run', side_effect=subprocess.CalledProcessError(2, ['adb'])) as run:
            with self.assertRaises(subprocess.CalledProcessError):
                start_report_reader()
            self.assertEqual(run.call_count, 1)


class QuietGuestTests(unittest.TestCase):
    def test_only_installed_background_apps_are_disabled(self):
        results = [subprocess.CompletedProcess([], 0, stdout=f'{AVD_NAME}\nOK\n'), subprocess.CompletedProcess([], 0),
                   subprocess.CompletedProcess([], 0, stdout='package:com.waze\npackage:com.google.android.apps.youtube.music\n'),
                   subprocess.CompletedProcess([], 0)]
        with patch('boot_emulator.run', side_effect=results) as run:
            quiet_software_guest()
        self.assertIn('hide_error_dialogs', run.call_args_list[1].args)
        disabled = [call.args[-1] for call in run.call_args_list if 'disable-user' in call.args]
        self.assertEqual(disabled, ['com.google.android.apps.youtube.music'])

    def test_another_emulator_is_left_untouched(self):
        with patch('boot_emulator.run', return_value=subprocess.CompletedProcess([], 0, stdout='other\nOK\n')) as run:
            with self.assertRaisesRegex(RuntimeError, 'owned'):
                quiet_software_guest()
        self.assertEqual(run.call_count, 1)


class CompileTests(unittest.TestCase):
    DEXOPT = ('  [com.waze]\n    path: /data/app/base.apk\n      x86_64: [status=%s] [reason=unknown]\n'
              '  [com.other]\n      x86_64: [status=speed]\n')

    def test_uncompiled_waze_is_compiled_ahead_of_time(self):
        with patch('boot_emulator.run', side_effect=[subprocess.CompletedProcess([], 0, stdout=self.DEXOPT % 'run-from-apk'),
                                                     subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 0)]) as run:
            compile_waze()
        self.assertIn('--no-watch-dog', run.call_args_list[1].args)
        self.assertEqual(run.call_args_list[2].args[-4:], ('-m', 'verify', '-f', 'com.waze'))

    def test_compiled_waze_is_not_recompiled_by_another_package_status(self):
        with patch('boot_emulator.run', return_value=subprocess.CompletedProcess([], 0, stdout=self.DEXOPT % 'verify')) as run:
            compile_waze()
        self.assertEqual(run.call_count, 1)


class AccelerationTests(unittest.TestCase):
    @patch.dict('os.environ', {'WAZE_EMULATOR_ACCEL': 'auto'})
    def test_kvm_is_used_only_when_the_device_is_usable(self):
        with patch('boot_emulator.os.path.exists', return_value=True), patch('boot_emulator.os.access', return_value=True):
            self.assertEqual(emulator_acceleration(), 'on')
        with patch('boot_emulator.os.path.exists', return_value=True), patch('boot_emulator.os.access', return_value=False):
            self.assertEqual(emulator_acceleration(), 'off')
        with patch('boot_emulator.os.path.exists', return_value=False):
            self.assertEqual(emulator_acceleration(), 'off')

    @patch.dict('os.environ', {'WAZE_EMULATOR_ACCEL': 'off'})
    def test_explicit_mode_overrides_detection(self):
        with patch('boot_emulator.os.path.exists', return_value=True), patch('boot_emulator.os.access', return_value=True):
            self.assertEqual(emulator_acceleration(), 'off')


if __name__ == '__main__': unittest.main()
