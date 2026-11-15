package com.balebase.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.os.Bundle;
import androidx.credentials.CustomCredential;
import androidx.credentials.PasswordCredential;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialInterruptedException;
import androidx.credentials.exceptions.GetCredentialUnknownException;
import androidx.credentials.exceptions.NoCredentialException;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import com.getcapacitor.JSObject;
import org.json.JSONException;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * What `PasswordManager.choose` hands the page (savePassword.ts): the chosen
 * password, nothing for a non-password credential, and no failure when nothing
 * was chosen.
 */
@RunWith(AndroidJUnit4.class)
public class PasswordManagerPluginTest {

    @Test
    public void chosenPasswordReachesThePage() throws JSONException {
        JSObject result = PasswordManagerPlugin.chosenSignIn(
            new PasswordCredential("owner@example.com", "correct horse battery")
        );
        JSObject credential = result.getJSObject("credential");
        assertEquals("owner@example.com", credential.getString("username"));
        assertEquals("correct horse battery", credential.getString("password"));
        assertEquals(1, result.length());
        assertEquals(2, credential.length());
    }

    @Test
    public void otherCredentialsChooseNothing() {
        JSObject result = PasswordManagerPlugin.chosenSignIn(
            new CustomCredential("com.example.TOKEN", new Bundle())
        );
        assertEquals(0, result.length());
    }

    @Test
    public void nothingSavedOrDismissedIsNoFailure() {
        assertTrue(PasswordManagerPlugin.choseNothing(new NoCredentialException()));
        assertTrue(PasswordManagerPlugin.choseNothing(new GetCredentialCancellationException()));
        assertFalse(PasswordManagerPlugin.choseNothing(new GetCredentialInterruptedException()));
        assertFalse(PasswordManagerPlugin.choseNothing(new GetCredentialUnknownException()));
    }
}
